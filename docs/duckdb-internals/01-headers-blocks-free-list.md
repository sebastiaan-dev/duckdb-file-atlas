# DuckDB file internals 1: headers, blocks, metadata blocks, and the free list

This document describes the physical layout of a single-file `.duckdb` database: the three 4 KiB header pages, the
fixed-size blocks after them, the metadata sub-block allocator, and the free-list and checkpoint protocol that decides
when a block can be reused. Section 10 checks the description against hex dumps of real files.

## 0. Scope, sources, and conventions

| Item | Value |
|---|---|
| Source tree | `/Users/sgerrits/repos/duckdb`, commit **`fb38af476a7`** ("perf(variant): Optimize shredded vector value retrieval (#25458)"), read-only |
| Citation format | `path:line` (or `path:first-last`) relative to the DuckDB repo root at that commit, plus the function name |
| Empirical binary | `/Users/sgerrits/.duckdb/cli/latest/duckdb` = **`v2.0.0-alpha49003 (Cyanoptera) b32b1368b8`** |
| Byte order | Everything is written with `Store<T>`/`WriteData` from native memory, so on every supported platform the byte order is **little-endian** |

**Version caveat (read this first).** The CLI's commit `b32b1368b8` is **not** an ancestor of `fb38af476a7`. The two
share merge base `94c8a84d645`. The CLI branch (`v2.0-cyanoptera`) is 4,621 commits past the merge base and the source
checkout is 21 commits past it. For the files in this document the **on-disk format is identical** in both trees. Both
use storage version 69, the same header layouts, the same block header, the same metadata sub-block layout, and the
same free-list serialization. The empirical bytes in section 10 therefore match the source description exactly. The
behavioural differences in the free-list code are listed in section 11. The one that matters most is whether
`free_blocks_in_use` is included in the persisted free list.

Some names in the task statement do not exist at this commit. There is no `newly_freed_list`, no `AllocateBlock` on the
single-file block manager, and no `LoadFreeList` call at checkpoint completion. The real equivalents are
`modified_blocks`, `free_blocks_in_use`, `newly_used_blocks`, `GetFreeBlockId*`, and `free_list_id`, and the document
uses those names.

---

## 1. Whole-file map

```
file offset                                                     size
0x00000  +-----------------------------------------------+
         | MainHeader page          (plain text, always)  |    4096  Storage::FILE_HEADER_SIZE
0x01000  +-----------------------------------------------+
         | DatabaseHeader h1 page   ("header 1")         |    4096
0x02000  +-----------------------------------------------+
         | DatabaseHeader h2 page   ("header 2")         |    4096
0x03000  +-----------------------------------------------+  <- BLOCK_START = 3 * 4096 = 12288
         | block 0                                       |    block_alloc_size (default 262144)
         +-----------------------------------------------+
         | block 1                                       |
         +-----------------------------------------------+
         | ...                                           |
         | block N  @ 12288 + N * block_alloc_size        |
         +-----------------------------------------------+
<db>.wal               separate file (write-ahead log)
<db>.wal.checkpoint    separate file, only while a checkpoint runs with concurrent commits
<db>.wal.recovery      separate file, only during recovery merging
```

- `Storage::FILE_HEADER_SIZE = 4096` is at `src/include/duckdb/storage/storage_info.hpp:56`. The comment there says
  the headers "should be small and written more or less atomically by the hard disk" (`storage_info.hpp:54-55`).
- `SingleFileBlockManager::BLOCK_START = Storage::FILE_HEADER_SIZE * 3` is at
  `src/include/duckdb/storage/single_file_block_manager.hpp:70`.
- Block location is computed in `SingleFileBlockManager::GetBlockLocation`
  (`src/storage/single_file_block_manager.cpp:1158-1160`) and repeated in `SingleFileBlockManager::Write`
  (`single_file_block_manager.cpp:1217-1220`): `BLOCK_START + block_id * GetBlockAllocSize()`.
- The WAL path is `<path>.wal`, built by `StorageManager::GetWALPath` (`src/storage/storage_manager.cpp:342-344`).
  `GetCheckpointWALPath` returns `.wal.checkpoint` (`storage_manager.cpp:346-348`) and `GetRecoveryWALPath` returns
  `.wal.recovery` (`storage_manager.cpp:350-352`).

---

## 2. Primitives used by every page: the checksum and the "block header"

### 2.1 The checksum function

`Checksum(const uint8_t *buffer, size_t size)` is defined at `src/common/checksum.cpp:67-79`:

```
result = 5381
for each 8-byte little-endian word x:   result ^= x * 0xbf58476d1ce4e5b9   (mod 2^64)   // checksum.cpp:7-9, 71-73
if size % 8 != 0: result ^= ChecksumRemainder(tail)                                     // checksum.cpp:74-77, 14-65
```

Properties that follow from the code:

- All checksummed regions are multiples of 8 bytes. `Storage::VerifyBlockHeaderSize` enforces 8-byte header alignment
  "for computing the checksum" (`src/storage/storage_info.cpp:286-301`). The remainder path is therefore never hit for
  file pages.
- It is an XOR of independent per-word products. An all-zero page has checksum `5381 = 0x1505`. The checksum is
  position-independent: permuting 8-byte words does not change it, and two equal words cancel. It detects random
  corruption and torn or zeroed pages well enough, but it is not a cryptographic MAC. Encrypted files use the AES-GCM
  tag for authentication (section 9).
- Empirically, the Python re-implementation in section 10.8 reproduced the stored checksum of every header page and
  every block in the test files.

### 2.2 The per-page header (`block_header_size`)

Every page the block manager writes, including the 4 KiB header pages, is a `FileBuffer` with `block_header_size`
reserved bytes in front of the user data:

| Constant | Value | Where |
|---|---|---|
| `DEFAULT_BLOCK_HEADER_STORAGE_SIZE` | 8 | `storage_info.hpp:35` |
| `Storage::DEFAULT_BLOCK_HEADER_SIZE` | `sizeof(idx_t)` = 8 | `storage_info.hpp:64` |
| `DEFAULT_ENCRYPTION_BLOCK_HEADER_SIZE` | 40 | `storage_info.hpp:37` |
| `Storage::MAX_BLOCK_HEADER_SIZE` | 128 | `storage_info.hpp:66` |
| `DBConfigOptions::default_block_header_size` | `DEFAULT_BLOCK_HEADER_STORAGE_SIZE` | `src/include/duckdb/main/config.hpp:148` |

- Plain files: the 8-byte header holds the checksum of the remaining `alloc_size - 8` bytes.
- Encrypted files: `StorageOptions::Initialize` sets `block_header_size = DEFAULT_ENCRYPTION_BLOCK_HEADER_SIZE` as soon
  as an `encryption_key` is given (`src/storage/storage_manager.cpp:97-108`). The block header size is **not stored in
  the file**. It is implied by whether a key is supplied: `StorageManager` takes it from the options
  (`storage_manager.cpp:513-526`), and `LoadExistingDatabase` refuses to open an encrypted file without a key
  (`single_file_block_manager.cpp:661-664`).

Define `delta = block_header_size - 8` (0 for plain files, 32 for encrypted files). It is computed in
`ChecksumAndWrite` (`single_file_block_manager.cpp:786`) and `ReadAndChecksum` (`single_file_block_manager.cpp:774`).
The checksum is always stored at byte `delta` of the page and covers the user area `[block_header_size, alloc_size)`:

- `ChecksumAndWrite` (`single_file_block_manager.cpp:784-814`): `checksum = Checksum(block.GetDataMutable(),
  block.Size())` (`:798`), then `Store<uint64_t>(checksum, block.InternalBuffer() + delta)` (`:801`), then the page is
  encrypted when needed (`:805-810`) and written (`:812`).
- `ReadAndChecksum` (`single_file_block_manager.cpp:768-782`): read, decrypt when needed (`:776-779`), then
  `CheckChecksum` (`:744-766`). `CheckChecksum` throws `DataCorruptionException("Corrupt database file: computed
  checksum %llu does not match stored checksum %llu in block at location %llu")` (`:760-765`).

The MainHeader is a special case (`skip_block_header = true`, section 3.4). It is never encrypted and always keeps the
plain 8-byte layout.

---

## 3. Page 0: the MainHeader

### 3.1 Purpose and lifetime

The class comment says the MainHeader "is written only once for a database file" (`storage_info.hpp:241-242`). It is
written by `SingleFileBlockManager::CreateNewDatabase` (`single_file_block_manager.cpp:584-586`). It is rewritten only
by `RewriteMainHeader` (`single_file_block_manager.cpp:860-868`) for storage-version upgrades from 64 to 65 or
downgrades from 999 to below 2.0.0. `WriteHeader` triggers those rewrites at `single_file_block_manager.cpp:1387-1397`.

### 3.2 Constants

| Constant | Value | Where |
|---|---|---|
| `MAGIC_BYTES` | `"DUCK"` | `single_file_block_manager.cpp:29` |
| `MAGIC_BYTE_SIZE` | 4 | `storage_info.hpp:246` |
| `MAGIC_BYTE_OFFSET` | `Storage::DEFAULT_BLOCK_HEADER_SIZE` = 8 | `storage_info.hpp:247` |
| `FLAG_COUNT` | 4 | `storage_info.hpp:248` |
| `ENCRYPTED_DATABASE_FLAG` | 1 (bit 0 of `flags[0]`) | `storage_info.hpp:251`, `IsEncrypted` `:291-293` |
| `MAX_VERSION_SIZE` | 32 | `storage_info.hpp:245` |
| `ENCRYPTION_METADATA_LEN` | 8 | `storage_info.hpp:271` |
| `DB_IDENTIFIER_LEN` | 16 | `storage_info.hpp:269` |
| `CANARY_BYTE_SIZE` | 8 | `storage_info.hpp:273` |
| `AES_NONCE_LEN` | 12 | `storage_info.hpp:275` |
| `AES_TAG_LEN` | 16 | `storage_info.hpp:279` |
| `CANARY` | `"DUCKKEY"` (plus NUL = 8 bytes) | `single_file_block_manager.cpp:30` |
| `DEPRECATED_VERSION_NUMBER` | `StorageVersion::DEPRECATED` = 999 | `storage_info.hpp:260`, enum `:149` |

### 3.3 Exact byte layout

The order comes from `MainHeader::Write` (`single_file_block_manager.cpp:176-197`) and is mirrored by
`MainHeader::Read` (`single_file_block_manager.cpp:217-268`). The serializer starts at page byte 8 because
`SerializeHeaderStructure` writes to `header_buffer.GetDataMutable()` (`single_file_block_manager.cpp:373-377`, call at
`:585`). The header buffer was built with header size `options.block_header_size` and a total of
`Storage::FILE_HEADER_SIZE` bytes (`single_file_block_manager.cpp:389-396`).

| File offset (dec) | Hex | Width | Field | Written by | Notes |
|---:|---:|---:|---|---|---|
| 0 | 0x000 | 8 | checksum of bytes `[8, 4096)` | `ChecksumAndWrite(..., 0, true)` `:586` | Always plain text, also in encrypted files |
| 8 | 0x008 | 4 | magic `"DUCK"` | `:177` | `CheckMagicBytes` reads exactly here (`:199-208`) |
| 12 | 0x00C | 8 | `version_number` (u64) | `:178-182` | Storage version ≥ v2.0.0 is written as **999** (`:179-181`). Older files hold 64..68. Note the field is not 8-byte aligned in the file |
| 20 | 0x014 | 32 | `flags[0..3]` (4 × u64) | `:183-185` | `flags[0]` bit 0 = encrypted. The rest are zero (`ConstructMainHeader` `:417-422`) |
| 52 | 0x034 | 32 | library version string (`DuckDB::LibraryVersion()`), NUL-padded | `SerializeVersionNumber` `:33-38`, call `:187` | Read into `library_git_desc` (`:259`) |
| 84 | 0x054 | 32 | source id / git hash (`DuckDB::SourceID()`), NUL-padded | `:188` | Read into `library_git_hash` (`:260`) |
| 116 | 0x074 | 8 | encryption metadata | `SerializeEncryptionMetadata` `:47-57`, call `:192` | Zeros unless encrypted. Layout in 3.5 |
| 124 | 0x07C | 16 | `db_identifier` (unique id, also the KDF salt) | `SerializeDBIdentifier` `:40-45`, call `:193` | Random when encrypted or storage ≥ v1.4.0 (`:543-546`, `GenerateDBIdentifier` `:95-99`). Otherwise zero |
| 140 | 0x08C | 8 | `encrypted_canary` | `SerializeEncryptionMetadata(ser, encrypted_canary, …)` `:194` | Zeros unless encrypted |
| 148 | 0x094 | 12 | `canary_iv` (GCM nonce of the canary) | `SerializeIV` `:59-70`, call `:195` | Zeros unless encrypted |
| 160 | 0x0A0 | 16 | `canary_tag` (GCM tag of the canary) | `SerializeTag` `:72-83`, call `:196` | Zeros unless encrypted |
| 176 | 0x0B0 | 3920 | unused | `header_buffer.Clear()` `:525` | Zero in practice. Covered by the checksum |

Notes:

- The in-memory `MainHeader::encryption_version` member (`storage_info.hpp:266`) is **not serialized**. The
  persisted encryption version is byte 3 of the encryption metadata, returned by `GetEncryptionVersion()`
  (`storage_info.hpp:310-312`).
- `MainHeader::Read` accepts 999 without checking. Any other value must lie in `[VERSION_NUMBER_LOWER,
  VERSION_NUMBER_UPPER] = [64, 69]` (`single_file_block_manager.cpp:226-251`, constants at
  `src/storage/storage_info.cpp:14-16`).
- `GetVersionNumber()` maps the requested storage version to the main-header number. Anything before v1.2.0 maps to
  `V0_10_2` = 64 (`single_file_block_manager.cpp:407-415`).

### 3.4 Checksum placement for the MainHeader in encrypted files

`ChecksumAndWrite(context, header_buffer, 0, true)` with `delta > 0` takes the branch at
`single_file_block_manager.cpp:789-796`:

1. `memmove` the serialized payload from page byte 40 down to page byte 8 (`:792`).
2. Zero the last `delta` = 32 bytes (`:794`).
3. Compute the checksum over `[8, 4096)` (`:795`).
4. Store it at byte 0 (`delta = 0`, `:796`, `:801`).
5. Skip encryption, because `skip_block_header` is true (`:805`).

The encrypted file's MainHeader is therefore byte-for-byte the same layout as the plain one. `CheckChecksum` mirrors
this (`:749-752`), and `LoadExistingDatabase` deserializes from `GetDataMutable() - delta`
(`single_file_block_manager.cpp:632-637`).

### 3.5 Encryption metadata (8 bytes at file offset 116)

Written by `SingleFileBlockManager::StoreEncryptionMetadata` (`single_file_block_manager.cpp:455-470`):

| Byte | Content | Source | Enum |
|---:|---|---|---|
| 116 | key derivation function | `:464` | `KeyDerivationFunction {DEFAULT=0, SHA256=1, PBKDF2=2}` `src/include/duckdb/common/encryption_types.hpp:18` |
| 117 | additional_authenticated_data flag | `:465` | bool |
| 118 | cipher | `:466`, `GetEncryptionCipher` = `encryption_metadata[2]` `storage_info.hpp:306-308` | `CipherType {INVALID=0, GCM=1, CTR=2, CBC=3}` `encryption_types.hpp:17` |
| 119 | encryption version | `:467` | `EncryptionVersion {V0_0=0, V0_1=1, NONE=127}` `encryption_types.hpp:20` |
| 120-123 | key length (u32 LE) | `:468` | 32 = `DEFAULT_ENCRYPTION_KEY_LENGTH` (`storage_info.hpp:253`) |

The code comment at `:458-461` still says "the subsequent byte is empty", but byte 3 now holds the encryption version.

**Canary.** `EncryptCanary` (`single_file_block_manager.cpp:101-131`) encrypts the known plaintext `"DUCKKEY\0"`. For
V0_1 it uses a random 12-byte nonce (stored in `canary_iv`) and AES-GCM, and stores the 16-byte tag (`:115-124`). For
V0_0 it uses an all-zero 16-byte nonce and no tag (`:108-113`). `DecryptCanary` (`:133-174`) verifies the canary on
open, and `CheckAndAddEncryptionKey` (`:472-510`) rejects a wrong key with "Wrong encryption key used to open the
database file" (`:503-505`). The key is derived from the user key with `db_identifier` as the salt (`:478-481`, and
`:550` on create).

---

## 4. Pages 1 and 2: the two DatabaseHeaders (h1, h2)

### 4.1 Struct

`struct DatabaseHeader` (`storage_info.hpp:377-398`):

| Field | C++ type | Meaning (source comment) |
|---|---|---|
| `iteration` | `uint64_t` | "increases by 1 every time the storage is checkpointed" (`:379`) |
| `meta_block` | `idx_t` | encoded `MetaBlockPointer::block_pointer` of the catalog root (`:381`) |
| `free_list` | `idx_t` | encoded `MetaBlockPointer::block_pointer` of the free-list chain (`:383`) |
| `block_count` | `uint64_t` | blocks in the file as of this header. "any blocks appearing AFTER block_count are implicitly part of the free_list" (`:384-386`) |
| `block_alloc_size` | `idx_t` | block allocation size (`:388`) |
| `vector_size` | `idx_t` | `STANDARD_VECTOR_SIZE` the file was written with (`:390`) |
| `storage_compatibility` | `StorageVersion` | the storage version, serialized as described in 4.2 (`:392`) |

### 4.2 Exact byte layout

`DatabaseHeader::Write` is at `single_file_block_manager.cpp:270-285` and `DatabaseHeader::Read` at
`single_file_block_manager.cpp:340-371`. The header pages are written by `ChecksumAndWrite` without
`skip_block_header`, so the checksum sits at byte `delta` and the payload starts at byte `block_header_size`.

Plain file (`block_header_size = 8`). Add 4096 for h1 or 8192 for h2.

| Page offset | Width | Field | Notes |
|---:|---:|---|---|
| 0 | 8 | checksum of page bytes `[8, 4096)` | `:798-801` |
| 8 | 8 | `iteration` | `:271` |
| 16 | 8 | `meta_block` | `:272`. `0xFFFFFFFFFFFFFFFF` = none (fresh DB, `:594`) |
| 24 | 8 | `free_list` | `:273`. `0xFFFFFFFFFFFFFFFF` = none (`:595`, `:1367`) |
| 32 | 8 | `block_count` | `:274` |
| 40 | 8 | `block_alloc_size` | `:275`. Reading 0 means 262144 for backward compatibility (`:347-350`) |
| 48 | 8 | `vector_size` | `:276`. Reading 0 means `DEFAULT_STANDARD_VECTOR_SIZE`. It must equal the compiled `STANDARD_VECTOR_SIZE`, otherwise `IOException` (`:352-361`) |
| 56 | 8 | storage version | For `storage_compatibility < V2_0_0`: the **deprecated serialization version** (`GetSerializationVersionDeprecated`, `:278-281`), e.g. 1 for v0.10.2, 4 for v1.2.0, 7 for v1.5.x (enum `storage_info.hpp:162-189`). For ≥ V2_0_0: the storage version itself, 69 (`:282-284`) |
| 64 | 4032 | unused | Zero after a checkpoint (`header_buffer.Clear()` at `:1386`). **Stale MainHeader bytes on a freshly created file** (4.6) |

Encrypted file (`block_header_size = 40`):

| Page offset | Width | Field |
|---:|---:|---|
| 0 | 12 | AES-GCM nonce (V0_1; 16 bytes for V0_0) — plain |
| 12 | 16 | AES-GCM tag — plain |
| 28 | 4 | zero padding — plain |
| 32 | 8 | checksum — **encrypted** |
| 40 | 56 | DatabaseHeader fields in the order above — **encrypted** |
| 96 | 4000 | rest — **encrypted** |

`DatabaseHeader::SetStorageVersionInDatabaseHeader` (`single_file_block_manager.cpp:287-338`) turns the stored value
back into a `StorageVersion`. If the main header says 999, or the value read is ≥ V2_0_0, only V2_0_0 is accepted
(`:289-297`). Otherwise the deprecated serialization version is mapped back: 0/1/2/3/64 to v0.10.2, 4 to v1.2.0, 5 to
v1.3.0, 6 to v1.4.0, 7 to v1.5.0 (`:310-336`).

### 4.3 Validation at open

`SingleFileBlockManager::Initialize` (`single_file_block_manager.cpp:816-858`) performs these checks:

- `Storage::VerifyBlockAllocSize(header.block_alloc_size)`. A failure becomes "Corrupt database file: invalid block
  allocation size" (`:817-822`).
- It sets `free_list_id`, `meta_block`, `iteration_count`, and `max_block = block_count` (`:824-827`).
- An explicitly requested storage version lower than the file's is rejected (`:828-835`).
- A file storage version newer than `Latest()` is rejected (`:841-846`).
- A user-provided block size that differs from the file's is rejected (`:850-855`). Finally
  `SetBlockAllocSize(header.block_alloc_size)` (`:857`).

### 4.4 Choosing the active header

`LoadExistingDatabase` (`single_file_block_manager.cpp:625-719`) works through these steps:

1. `handle->CheckMagicBytes` (`:627`). Then the MainHeader is read with `ReadAndChecksum(…, 0, true)` (`:630`) and
   deserialized (`:637`).
2. Encryption and key checks (`:640-696`).
3. `ReadAndChecksum` on h1 at 4096 and on h2 at 8192 (`:699-705`). **Both must pass the checksum.** A mismatch in
   either throws, even if it is in the older header (section 5.4 and section 12).
4. `if (h1.iteration > h2.iteration)` makes h1 active (`active_header = 0`, `:708-711`). Otherwise h2 is active
   (`active_header = 1`, `:712-716`). **A tie goes to h2.** That is the fresh-file state, where both iterations are 0.
5. `LoadFreeList` (`:718`, section 8.6).

### 4.5 Alternation on write

- On create (`single_file_block_manager.cpp:588-622`), h1 and h2 are both written with iteration 0,
  `meta_block = free_list = INVALID_BLOCK` cast to `idx_t` (`0xFFFF…FF`), and `block_count = 0` (`:592-615`). Then
  `Sync()` (`:618`), `iteration_count = 0`, and `active_header = 1` (h2 active, "this way our initial write will be in
  h1", `:619-621`).
- In `WriteHeader`:
  - `header.iteration = ++iteration_count` (`:1330`).
  - `location = active_header == 1 ? FILE_HEADER_SIZE : FILE_HEADER_SIZE * 2` (`:1405`). The header is always written
    to the **inactive** page.
  - `ChecksumAndWrite` (`:1406`), then `active_header = 1 - active_header` (`:1408`).
- The result is that odd iterations live in h1 and even iterations in h2 (iteration 0 is in both on a fresh file). The
  run in section 10 shows exactly this: iteration 1 in h1, then 2 in h2, then 3 in h1.

### 4.6 Fresh-file quirk: stale MainHeader bytes inside h1/h2

`CreateNewDatabase` clears `header_buffer` only once (`:525`). It then serializes the MainHeader (176 bytes) and the
DatabaseHeader (56 bytes) **into the same buffer** without clearing in between (`:585`, `:601`, `:614`). In the fresh
h1/h2 pages, page bytes 64-175 therefore still contain the tail of the MainHeader: the end of the version string, the
git hash, and the db_identifier. The checksum covers these bytes, and they are harmless because `DatabaseHeader::Read`
only reads 56 bytes. After the first checkpoint the rewritten header page is clean, because `WriteHeader` calls
`header_buffer.Clear()` at `:1386`. The h2 page of the fresh file in section 10.2 shows these stale bytes.

---

## 5. The checkpoint write protocol, fsync ordering, and crash behaviour

### 5.1 Sequence (`SingleFileCheckpointWriter::CreateCheckpoint` and `SingleFileBlockManager::WriteHeader`)

```
CreateCheckpoint                         src/storage/checkpoint_manager.cpp:196-373
 1  metadata_writer / table_metadata_writer created                     :212-213
 2  meta_block = metadata_writer->GetMetaBlockPointer()  (planned root)  :216
 3  WALStartCheckpoint(meta_block): if WAL non-empty, append CHECKPOINT
    marker with planned root, flush, switch to <db>.wal.checkpoint      :232, storage_manager.cpp:251-305
 4  serialize catalog + table data: data blocks written via
    PartialBlockManager / ConvertToPersistent (block_manager.cpp:59-118 -> Write)
 5  metadata_writer->Flush(); table_metadata_writer->Flush()             :280-281   (releases handles only)
 6  [debug abort point BEFORE_HEADER]                                    :283-289
 7  WriteHeader(header{meta_block, block_alloc_size, vector_size})       :292-296
      a  GetFreeListBlocks()  pre-allocate free-list metadata sub-blocks single_file_block_manager.cpp:1321
      b  MetadataManager::MarkBlocksAsModified()                         :1326
      c  iteration = ++iteration_count                                   :1330
      d  compute all_free_blocks = free_list ∪ modified_blocks ∪ newly_used_blocks
         and written_multi_use_blocks                                    :1332-1342
      e  serialize free list + multi-use + metadata-block bitmaps        :1344-1368
      f  MetadataManager::Flush(): write every dirty metadata block      :1370
      g  header.block_count = max_block                                  :1372-1374
      h  [debug abort AFTER_FREE_LIST_WRITE]                             :1378-1381
      i  handle->Sync()           <== fsync #1: all data + metadata      :1384
      j  (optional RewriteMainHeader + Sync)                             :1386-1397
      k  serialize header, ChecksumAndWrite to inactive page             :1399-1406
      l  active_header = 1 - active_header                               :1408
      m  handle->Sync()           <== fsync #2: the header               :1410
      n  modified blocks of this checkpoint -> free_list / free_blocks_in_use  :1411-1420
      o  TrimFreeBlocks (punch holes, opt-in)                            :1422
 8  optional VerifyBlocks (debug_verify_blocks)                          :298-326
 9  [debug abort BEFORE_TRUNCATE]                                        :328-330
10  block_manager.Truncate()  (drop trailing free blocks from the file)  :333
11  [debug abort BEFORE_WAL_FINISH]                                      :335-337
12  WALFinishCheckpoint: delete <db>.wal (or move .wal.checkpoint over it) :339-352, storage_manager.cpp:307-336
```

`handle->Sync()` maps to `DatabaseHandle::Sync`, which calls the file handle's or the mmap's `Sync`
(`src/storage/database_handle.cpp:134-140`).

### 5.2 What becomes durable when

| After step | Durable on-disk state | Which header is authoritative after a crash |
|---|---|---|
| 4-5 | New data blocks are written, but only to blocks that are **free in the durable header**, or past its `block_count`. Section 8 explains why | Old header (iteration *k*) |
| 7f | New metadata blocks are written. **Caveat:** metadata blocks that still hold live sub-blocks of the old checkpoint are rewritten in place (7.7) | Old header |
| 7i | Everything except the header is fsynced | Old header |
| 7k | New header written to the inactive page, not yet fsynced | Old or new, whichever the device persisted (relies on 4 KiB write atomicity) |
| 7m | New header fsynced | **New header (iteration *k+1*)** |
| 10 | File may be shorter than `block_count × alloc_size` | New header. Blocks past EOF are free in its free list |
| 12 | WAL deleted or replaced | New header, no WAL replay needed |

### 5.3 Crash matrix

| Crash point | Effect on reopen |
|---|---|
| Before step 3 | Old header, WAL replayed normally |
| Between 3 and 7m (inclusive of 7i/7k before durability) | Old header is chosen (higher durable iteration). The WAL ends with a CHECKPOINT marker. `WriteAheadLogDeserializer` calls `IsCheckpointClean(checkpoint_id)` = `SingleFileBlockManager::IsRootBlock`, which compares `root.block_pointer == meta_block` (`src/storage/storage_manager.cpp:723-725`, `single_file_block_manager.cpp:894-896`). The roots differ, so the WAL is replayed, merged with `.wal.checkpoint` if that exists (`src/storage/wal_replay.cpp:511-575`). All blocks written by the failed checkpoint are free in the old header's free list, so they are simply reused. Section 10.4 reproduces this with `debug_checkpoint_abort='before_header'`: after the abort, h1 and h2 were unchanged, the WAL was 967 bytes, reopen replayed it (500,000 rows visible), and the next checkpoint wrote iteration 3 to h1 |
| After 7m, before 12 | New header. The CHECKPOINT marker root equals the new `meta_block`, so the checkpoint counts as successful. With no `.wal.checkpoint` "we are done" (`wal_replay.cpp:533-538`). With one, only the checkpoint WAL is replayed (`:543-561`) |
| During 10 (truncate) | New header. Truncation only removes blocks that are free in the new header |
| Torn write of the header page (7k) | That page fails its checksum. `LoadExistingDatabase` **throws** instead of falling back to the other page (5.4) |

### 5.4 Header-atomicity assumption

There is no fallback. `ReadAndChecksum` is called for both h1 and h2 (`single_file_block_manager.cpp:700`, `:704`),
and `CheckChecksum` throws on mismatch (`:760-765`). Crash safety of the double header therefore assumes the 4 KiB
header write is atomic, which is the assumption stated at `storage_info.hpp:54-55`. This was checked empirically:
flipping one byte inside the *older* h1 of a file whose active header is h2 makes the file unopenable with
`Corrupt database file: computed checksum … in block at location 4096` (section 10.5). This is tracked as bean
`repos-shfp`.

---

## 6. Blocks

### 6.1 Identifiers and limits

| Name | Value | Where | Meaning |
|---|---|---|---|
| `block_id_t` | `int64_t` | `storage_info.hpp:49` | block number |
| `INVALID_BLOCK` | `-1` | `storage_info.hpp:28` | "no block". In `idx_t` fields it reads as `0xFFFF…FF` |
| `MAXIMUM_BLOCK` | `4611686018427388000` | `storage_info.hpp:30` | Commented as "2^62", but the value is 2^62 + 96. Ids `>= MAXIMUM_BLOCK` are **transient** (in-memory or temporary) |
| `DConstants::INVALID_INDEX` | `~0ULL` | — | used as `MetaBlockPointer` "invalid" (`src/include/duckdb/storage/block.hpp:52`, `:59-61`) |

Transient ids come from `StandardBufferManager::temporary_id`. It is initialized to `MAXIMUM_BLOCK`
(`src/storage/standard_buffer_manager.cpp:73`) and pre-incremented for every in-memory buffer (`:162`, `:185`).
`BlockHandle::~BlockHandle` returns early for ids `>= MAXIMUM_BLOCK` and otherwise unregisters the persistent block
(`src/storage/buffer/block_handle.cpp:169-179`).

### 6.2 Sizes

| Constant | Value | Where |
|---|---|---|
| `DEFAULT_BLOCK_ALLOC_SIZE` | 262144 (256 KiB) | `storage_info.hpp:33` |
| `Storage::MIN_BLOCK_ALLOC_SIZE` | 16384 | `storage_info.hpp:60` |
| `Storage::MAX_BLOCK_ALLOC_SIZE` | 262144 | `storage_info.hpp:62` |
| `Storage::DEFAULT_BLOCK_SIZE` | 262144 − 8 = 262136 | `storage_info.hpp:68` |
| `Storage::SECTOR_SIZE` | 4096 | `storage_info.hpp:53` |

- **Allowed sizes.** `Storage::VerifyBlockAllocSize` (`src/storage/storage_info.cpp:264-284`) requires a power of two
  in `[16384, 262144]` that also fits in `int32`. The allowed values are therefore **16 KiB, 32 KiB, 64 KiB, 128 KiB,
  and 256 KiB**.
- **Where the size comes from.**
  - The `block_size` ATTACH option sets `block_alloc_size` (`storage_manager.cpp:93-96`). The source comment notes it
    is the *allocation* size even though the option is called `block_size`.
  - New files use that option or the `default_block_size` setting, default `"262144"`
    (`src/include/duckdb/main/settings.hpp:959-971`, `storage_manager.cpp:475-483`).
  - Existing files use the header value, and a conflicting option is an error (`storage_manager.cpp:539-547`).
- **Allocation size vs usable size.** `BlockManager::GetBlockSize() = block_alloc_size - block_header_size`
  (`src/include/duckdb/storage/block_manager.hpp:143-146`). `GetBlockHeaderSize()` falls back to 8 when unset
  (`block_manager.hpp:136-142`).

| `block_alloc_size` | plain usable (`-8`) | encrypted usable (`-40`) |
|---:|---:|---:|
| 16384 | 16376 | 16344 |
| 32768 | 32760 | 32728 |
| 65536 | 65528 | 65496 |
| 131072 | 131064 | 131032 |
| 262144 | 262136 | 262104 |

Compile-time guard: `storage_info.hpp:408` reads `#if (DEFAULT_BLOCK_ALLOC_SIZE & (DEFAULT_BLOCK_ALLOC_SIZE - 1) !=
0)`. Because `!=` binds tighter than `&`, this evaluates `A & ((A-1) != 0)` = `A & 1`. The check is therefore a no-op
for every even value. The runtime `IsPowerOfTwo` check is the real guard.

### 6.3 Per-block on-disk layout

```
plain block (alloc A):         [0..8) checksum(u64 of [8..A)) | [8..A) payload (A-8 bytes)
encrypted block (alloc A):     [0..12) nonce | [12..28) tag | [28..32) 0 | [32..40) checksum* | [40..A) payload*
                               (* = AES ciphertext; checksum is over plaintext payload)
```

Each part is set by the following code:

- The checksum is set by `ChecksumAndWrite` (`single_file_block_manager.cpp:798-801`).
- `EncryptionEngine::EncryptBlock` (`src/common/encryption_functions.cpp:83-117`) handles encryption:
  - It generates a random nonce and stores it at internal byte 0 (`:94-98`).
  - It encrypts `block.Size() + 8` bytes starting at internal byte `delta`, i.e. the checksum plus the payload
    (`:101-110`).
  - It stores the 16-byte tag right after the nonce (`:112-116`).
- `DecryptBlock` (`:119-150`) reverses this. `Finalize` verifies the tag (`:148-149`).
- Nonce length (`src/common/encryption_types.cpp:117-177`): `EncryptionNonce::size()` is 12 for V0_1 and 16 for V0_0.
  For CTR under V0_1 the buffer is 16 bytes (IV), but only `size()` = 12 bytes are stored.

### 6.4 In-memory classes

| Class | Role | Source |
|---|---|---|
| `FileBuffer` | Owns `internal_buffer` of `internal_size` bytes (sector-aligned) and exposes `buffer = internal_buffer + header_size`, `size = internal_size - header_size`. `Read`/`Write` move the **whole internal buffer** (header + payload) | `src/include/duckdb/common/file_buffer.hpp:28-119`, `src/common/file_buffer.cpp:83-104` (`CalculateMemory` aligns `header + user_size` to `SECTOR_SIZE`), `:114-146` |
| `Block : FileBuffer` | `FileBuffer` plus `block_id_t id` | `src/include/duckdb/storage/block.hpp:21-29`, `src/storage/block.cpp:9-26` |
| `BlockPointer` | `{block_id_t block_id; uint32_t offset; uint32_t pad}` | `block.hpp:31-47` |
| `MetaBlockPointer` | `{idx_t block_pointer; uint32_t offset; uint32_t pad}` (section 7.2) | `block.hpp:49-76` |
| `BlockHandle` | One per block id (persistent or transient) and owns a `BlockMemory`. Loads the block on pin via `BlockManager::CreateBlock` + `Read` | `src/include/duckdb/storage/buffer/block_handle.hpp:251-311`, `src/storage/buffer/block_handle.cpp:195-229` |
| `BlockManager` | Abstract interface. Holds the `block_id → weak_ptr<BlockHandle>` map and the `MetadataManager` | `src/include/duckdb/storage/block_manager.hpp:31-205`, `src/storage/buffer/block_manager.cpp` |
| `SingleFileBlockManager` | The file-backed implementation that owns all of section 8 | `single_file_block_manager.hpp:67-231` |

**Interaction with the buffer manager.**

- `BlockManager::RegisterBlock(id)` creates or returns the unique `BlockHandle` for a persistent id
  (`block_manager.cpp:40-57`).
- When a pin loads the block, `BlockHandle::Load` calls `block_manager.Read`, i.e. `SingleFileBlockManager::Read`,
  then `ReadAndChecksum` (`single_file_block_manager.cpp:1190-1194`). Prefetch uses `ReadBlocks`, which checksums
  every block in a contiguous run (`:1196-1211`, driven by `StandardBufferManager::BatchRead`
  `standard_buffer_manager.cpp:241-252`).
- New data is created in transient buffers (`StandardBufferManager::RegisterMemory` with
  `block_manager->GetBlockSize()` / `GetBlockHeaderSize()`, `standard_buffer_manager.cpp:171-197`).
- `BlockManager::ConvertToPersistent(id, old_block)` (`block_manager.cpp:59-118`) makes a transient buffer
  persistent. It registers the persistent id (`:63`), makes a copy first in `THREAD_SAFE` mode (`:67-76`), turns the
  buffer into a `Block` (`:94`), **writes it to disk immediately** (`:97`), and swaps the memory into the new handle
  (`:100`).
- `CreateBlock` optionally fills new blocks with 0x00 or 0xFF (`options.debug_initialize`,
  `single_file_block_manager.cpp:1146-1156`, `FileBuffer::Initialize` `file_buffer.cpp:152-158`). That is a
  memory-debug feature. **No code zeroes freed blocks on disk**, except `Trim` (8.9).

**Persistent vs temporary.** Persistent blocks have ids `< MAXIMUM_BLOCK` and live at `BLOCK_START + id × alloc` in
the `.duckdb` file. Transient blocks have ids `> MAXIMUM_BLOCK` and are never written to the `.duckdb` file at that
id. When evicted, they go to the temporary directory through the `TemporaryFileManager`
(`src/storage/temporary_file_manager.cpp`), which is outside the database file.

---

## 7. Metadata blocks

### 7.1 Sub-block geometry

A metadata block is a normal block whose payload is split into `MetadataManager::METADATA_BLOCK_COUNT = 64` sub-blocks
(`src/include/duckdb/storage/metadata/metadata_manager.hpp:56-57`). The sub-block size comes from
`MetadataManager::GetMetadataBlockSize`, which is
`AlignValueFloor(block_manager.GetBlockSize() / METADATA_BLOCK_COUNT)` (`src/storage/metadata/metadata_manager.cpp:344-346`).
`AlignValueFloor` defaults to an 8-byte alignment (`src/include/duckdb/common/helper.hpp:213-216`).

| `block_alloc_size` | usable (plain) | sub-block size | 64 × sub | leftover (zeroed at flush) |
|---:|---:|---:|---:|---:|
| 262144 | 262136 | **4088** | 261632 | 504 |
| 131072 | 131064 | 2040 | 130560 | 504 |
| 65536 | 65528 | 1016 | 65024 | 504 |
| 32768 | 32760 | 504 | 32256 | 504 |
| 16384 | 16376 | **248** | 15872 | 504 |
| 262144 (encrypted) | 262104 | 4088 | 261632 | 472 |

`MetadataManager::Flush` zeroes the leftover tail (`metadata_manager.cpp:279`, `:293`).

```
metadata block (plain, 256 KiB):
 file: BLOCK_START + id*A
 +0      checksum (8)
 +8      sub-block 0   [0..8) next-pointer | [8..4088) data
 +4096   sub-block 1
 ...
 +8+i*4088  sub-block i
 +261640 .. +262144   504 zero bytes
```

### 7.2 Pointer encodings

- **`MetaBlockPointer`** (`block.hpp:49-76`) consists of `block_pointer` (u64) and `offset` (u32).
  - `block_pointer = block_id | (sub_index << 56)`, built by `MetadataManager::GetDiskPointer`
    (`metadata_manager.cpp:196-200`).
  - `GetBlockId() = block_pointer & ~(0xFF << 56)` and `GetBlockIndex() = block_pointer >> 56`
    (`metadata_manager.cpp:202-208`).
  - Indices `>= 64` are rejected with `IOException` (`:218-220`).
  - `offset` is the byte offset **inside the sub-block** and includes the 8-byte next pointer.
  - When serialized as an object it is the property pair 100/101 (`src/storage/serialization/serialize_storage.cpp:108-118`).
- **`DatabaseHeader.meta_block` / `.free_list`** store only `block_pointer`. The offset is implied to be 0, and the
  reader moves it to 8 (`metadata_reader.cpp:77-79`). Examples from the test file: `0x0000000000000006` is block 6,
  sub-block 0. `0x0200000000000006` is block 6, sub-block 2.
- **`MetadataPointer`** (in-memory only) is the bitfield `{block_index:56, index:8}` (`metadata_manager.hpp:45-48`).
- **`BlockPointer` conversion**: `ToBlockPointer` computes `offset = index × sub_size + meta.offset`
  (`metadata_manager.cpp:243-254`), and `FromBlockPointer` is the inverse (`:256-271`). Note that the `BlockPointer`
  offset is relative to the block *payload*.
- **Absolute file offset** of `MetaBlockPointer{bp, off}`: `12288 + (bp & 0x00FFFFFFFFFFFFFF) × A + 8 + (bp >> 56) ×
  sub_size + off`.

### 7.3 `MetadataWriter`: chaining

`src/storage/metadata/metadata_writer.cpp`:

- `NextBlock()` (`:43-61`) runs these steps:
  1. Obtain a new handle with `NextHandle()`, which by default calls `manager.AllocateHandle()` (`:39-41`).
  2. If a sub-block is already open, store the new sub-block's encoded `block_pointer` in the **first 8 bytes of the
     current sub-block** (`:48-51`).
  3. Switch to the new sub-block, set `offset = 8`, `capacity = sub_size`, and write `-1` (`0xFFFF…FF`) as the new
     sub-block's next pointer (`:53-57`).
  4. Record the pointer in `written_pointers` if requested (`:58-60`).
- `WriteData` spills across sub-blocks (`:63-80`).
- `GetMetaBlockPointer()` returns `{block_pointer, offset}` of the current write position (`:23-30`). On a new writer
  this triggers the first `NextBlock`, which is how `CreateCheckpoint` learns the root before writing anything
  (`checkpoint_manager.cpp:216`).
- `Flush()` zeroes the rest of the current sub-block and releases the pin (`:82-88`). It does **not** write to disk.
  Disk writes happen in `MetadataManager::Flush` (7.5).

### 7.4 `MetadataReader`

`src/storage/metadata/metadata_reader.cpp`:

- `ReadNextBlock` (`:60-86`) resolves the pointer. `EXISTING_BLOCKS` uses `FromDiskPointer`, and `REGISTER_BLOCKS`
  uses `RegisterDiskPointer`, which registers the block with the block manager on the fly (`:15-21`,
  `metadata_manager.cpp:233-241`).
- It then pins the block and reads the next pointer from the sub-block's first 8 bytes. `-1` means end of chain
  (`:71-76`).
- It starts at `max(offset, 8)` (`:77-83`).

### 7.5 `MetadataManager` state and allocation

State (`metadata_manager.hpp:99-103`):

- `blocks: unordered_map<block_id_t, MetadataBlock>`, where each `MetadataBlock` holds the block handle, the block id,
  `vector<uint8_t> free_blocks`, and `atomic<bool> dirty` (`:21-43`).
- `modified_blocks: unordered_map<block_id_t, idx_t>`, a per-block bitmask of sub-blocks to free at the next
  checkpoint.

The main operations:

- **`AllocateHandle`** (`metadata_manager.cpp:54-96`):
  - It takes the first block in `blocks` that has a free sub-block (`:60-67`).
  - If there is none, it allocates a new metadata block (`:69-73`). It also does so when the candidate's id is greater
    than `PeekNextBlockId()`, which prefers filling lower ids.
  - It marks the block dirty (`:81`).
  - If the block is still the on-disk persistent version (`BlockId() < MAXIMUM_BLOCK`), it is first converted to a
    transient copy: `ConvertToTransient` (`:82-87`, `:130-150`) copies the bytes and unregisters the persistent id.
  - It takes `free_blocks.back()` (`:89-91`). `free_blocks` is kept in descending order, so this is the
    **lowest-numbered** free sub-block.
- **`AllocateNewBlock`** (`:152-170`):
  - The block id comes from `block_manager.GetFreeBlockIdForCheckpoint()` (`:493-495`). Metadata blocks are therefore
    never placed in `newly_used_blocks`.
  - The buffer is a transient `MemoryTag::METADATA` buffer. All 64 sub-blocks start free (pushed 63..0), and the
    buffer is zero-filled (`:157-165`).
- **`Flush`** (`:277-313`), for every dirty block:
  1. Zero the tail.
  2. If transient, write it under its persistent id using `ConvertToPersistent(..., THREAD_SAFE)`. Otherwise call
     `block_manager.Write` (`:295-309`).
  3. Clear `dirty`.

### 7.6 Free-sub-block bitmask: serialization and the modified cycle

- **Serialization.**
  - `MetadataBlock::Write` writes `block_id` (i64) followed by `FreeBlocksToInteger()` (u64) (`metadata_manager.cpp:339-342`).
  - In the bitmask, **bit i set means sub-block i is free** (`:356-364`). `FreeBlocksFromInteger` /
    `BlocksFromInteger` rebuild the vector in descending order (`:366-384`).
  - `MetadataManager::Write` writes `u64 count` and then the `count` entries (`:315-320`).
  - `MetadataManager::Read` registers unknown blocks or overwrites the free list of known ones (`:322-337`).
- **`MarkBlocksAsModified()`** (`:386-419`) is called once at load (`LoadFreeList`, single_file_block_manager.cpp:891)
  and once at the start of every `WriteHeader` (`:1326`).
  1. For every `(block, mask)` in `modified_blocks`, it computes `free |= mask`. These are the sub-blocks that
     belonged to the previous checkpoint and were not reused.
  2. If that makes the block entirely free (`== ~0`), the metadata block is dropped from `blocks` and
     `block_manager.MarkBlockAsModified(block_id)` is called, which hands the whole block to section 8 (`:398-404`).
     Otherwise the free list is updated (`:405-408`).
  3. It resets `modified_blocks` to `~free` for **every** block. All currently occupied sub-blocks become candidates
     for freeing at the next checkpoint (`:411-418`).
- **`ClearModifiedBlocks(pointers)`** (`:421-437`) clears the bit for each pointer, which means "this sub-block is
  still referenced by the new checkpoint". Callers reuse unchanged metadata:
  - unchanged tables: `TableDataWriter`, `src/storage/checkpoint/table_data_writer.cpp:137-145`
  - row groups: `src/storage/table/row_group.cpp:1750-1751`, `:1873`, `:1947`
  - `src/storage/table/row_group_collection.cpp:1780-1784`
  - `src/storage/table/row_version_manager.cpp:245`
- `BlockIsModified` and `BlockHasBeenCleared` (`:439-460`) let row-group code ask whether a pointer can be reused.

**Net lifecycle of one metadata sub-block:**

```
free ──AllocateHandle (checkpoint k)──▶ occupied, dirty
     ──MarkBlocksAsModified at WriteHeader(k)──▶ occupied, in modified mask
     ──(checkpoint k+1 reuses it? ClearModifiedBlocks clears bit → stays occupied)
     ──MarkBlocksAsModified at WriteHeader(k+1)──▶ free (in memory) — persisted as free in header k+1
```

When a sub-block is freed in memory at step `WriteHeader(k+1)` (b), header *k+1* is not durable yet. This is safe
because the free-list sub-blocks for *k+1* were reserved **before** `MarkBlocksAsModified` (`GetFreeListBlocks` at
`:1321`). Nothing else allocates metadata between (b) and the header fsync, so sub-blocks of checkpoint *k* are not
overwritten before *k+1* is durable.

### 7.7 Caveat: metadata blocks are rewritten in place

The sub-blocks of checkpoint *k+1* are often placed in the **same physical block** that still holds the sub-blocks of
the durable checkpoint *k*. `MetadataManager::Flush` then rewrites that block at the same file offset before the new
header is written. The old sub-block bytes are preserved by the `ConvertToTransient` copy, but the block checksum
covers the full block. A torn multi-sector write of that block during a crash could therefore make checkpoint *k*
fail its checksum. Sections 10.3-10.4 observe this: checkpoint 1 used block 6 sub-blocks 0-2, checkpoint 2 used block 6
sub-blocks 3-5, and the block 6 checksum changed from `fe5f463faa416d95` to `dda87cf999104467` while h1 still pointed
into block 6. This is a hypothesis about torn writes, not an observed corruption. It is recorded as bean `repos-9ftg`.

---

## 8. `SingleFileBlockManager` free-list management

### 8.1 State (all guarded by `single_file_block_lock`, `single_file_block_manager.hpp:229-230`)

| Member | Type | Meaning (source comment) |
|---|---|---|
| `free_list` | `set<block_id_t>` | "free blocks that can be written to currently" (`hpp:207-208`). **Invariant: every member is free in the durable header** |
| `free_blocks_in_use` | `set<block_id_t>` | "freed, but cannot yet be re-used because they are still in-use" (`hpp:209-210`). A live `BlockHandle` still exists |
| `newly_used_blocks` | `set<block_id_t>` | "in-use, but haven't been written as part of a checkpoint yet" (`hpp:211-212`), i.e. optimistic writes |
| `multi_use_blocks` | `unordered_map<block_id_t,uint32_t>` | blocks with >1 reference. The count is the total number of references (`hpp:213-216`) |
| `modified_blocks` | `unordered_set<block_id_t>` | "no longer in-use, but cannot be re-used until the next checkpoint" (`hpp:217-218`) |
| `meta_block` | `idx_t` | root of the loaded header (`hpp:219-220`). Set only in `Initialize` (`.cpp:825`), **not updated by `WriteHeader`** |
| `max_block` | `block_id_t` | "the current maximum block id … given away first after the free_list runs out" (`hpp:221-222`) |
| `free_list_id` | `idx_t` | encoded pointer of the free-list chain from the loaded header (`hpp:223-224`, `.cpp:824`) |
| `iteration_count` | `uint64_t` | header iteration (`hpp:225-226`) |
| `active_header` | `uint8_t` | 0 = h1, 1 = h2 (`hpp:199-200`) |

Implicit state: block ids in `[0, max_block)` that are in none of the sets above are **used**, with a reference count
of 1. Nothing is stored per used block. On load, every non-free block is implicitly used.

### 8.2 Allocation

- **`GetFreeBlockIdInternal(type)`** (`single_file_block_manager.cpp:898-917`):
  - It takes the **smallest** id in `free_list` (`:901-905`). If the list is empty it takes `max_block++` (`:906-907`).
  - `NEWLY_USED_BLOCK` adds the id to `newly_used_blocks` (`:909-911`).
  - It throws if a `BlockHandle` is still registered for the id (`:912-914`).
  - **`GetFreeBlockId`** uses `NEWLY_USED_BLOCK` (`:919-921`). It serves optimistic writes, e.g.
    `PartialBlockManager` with `APPEND_TO_TABLE` (`src/storage/partial_block_manager.cpp:98-104`) and
    `src/storage/table/column_checkpoint_state.cpp:73`.
  - **`GetFreeBlockIdForCheckpoint`** uses `CHECKPOINTED_BLOCK` (`:923-925`). It serves `FULL_CHECKPOINT` writes
    (`partial_block_manager.cpp:99-100`), metadata (`metadata_manager.cpp:493-495`), and WAL index replay
    (`src/storage/wal_replay.cpp:913`).
- **`PeekFreeBlockId`** (`:927-934`) returns the same id without taking it.
- There is no `AllocateBlock` on the block manager. `PartialBlockManager::AllocateBlock`
  (`partial_block_manager.cpp:86-96`) calls `GetFreeBlockId` for full checkpoints and uses `INVALID_BLOCK` (assigned
  later) otherwise.

### 8.3 Reference changes

- **`MarkBlockAsCheckpointed(id)`** (`:936-940`) removes the id from `newly_used_blocks`. Callers:
  - after column data is checkpointed, via `CheckpointBlockIdMarker` (`src/storage/table/column_data_checkpointer.cpp:400-409`)
  - after optimistic row groups are referenced by a committed WAL entry
    (`WriteAheadLog::WriteRowGroupData`, `src/storage/write_ahead_log.cpp:511-523`)
- **`MarkBlockAsUsed(id)`** (`:942-962`):
  - If `id >= max_block`, every id in between goes to `free_list` and `max_block = id+1`.
  - Else, if the id is in `free_list`, it is removed.
  - Otherwise the reference count is incremented.
  - It is called only by WAL replay of `ROW_GROUP_DATA` in the deserialize pass, so blocks referenced by the WAL are
    taken out of the loaded free list before anything else can allocate them (`wal_replay.cpp:1305-1321`).
- **`IncreaseBlockReferenceCount(id)`** (`:1103-1106`) and its internal form (`:1001-1011`) go from implicit 1 to 2,
  then `++`. This is used when a partial block is shared by several segments (`column_checkpoint_state.cpp:89`).
- **`MarkBlockAsModified(id)`** (`:964-999`), the "free" operation:
  1. If the id is in `multi_use_blocks`, decrement. At `<= 1` the entry is erased and the block reverts to
     implicitly-used. **Return** (`:969-980`).
  2. Throw if the id is already in `modified_blocks` or `free_list`, to catch double frees (`:982-987`).
  3. If the id is in `newly_used_blocks`, no durable header ever referenced it, so it is erased and goes through
     `AddFreeBlock`, which **makes it reusable immediately** (`:988-993`).
  4. Otherwise it goes into `modified_blocks` and becomes reusable only after the next header is durable (`:994-998`).

  Callers:
  - `CommitDropState::FinalizeCommit`, for dropped tables, columns, and rolled-back optimistic data
    (`src/transaction/commit_state.cpp:46-60`, used by `LocalTableStorage::Rollback`
    `src/storage/local_storage.cpp:264-277`)
  - `CheckpointBlockIdDropper`, for segments replaced during a checkpoint (`column_data_checkpointer.cpp:273-282`)
  - index buffers (`src/execution/index/fixed_size_buffer.cpp:79`, `:108`; `src/execution/index/unbound_index.cpp:41`)
  - wholly freed metadata blocks (`metadata_manager.cpp:403`)
- **`AddFreeBlock(lock, id)`** (`:1300-1318`): if no live `BlockHandle` exists (`TryGetBlock`), the id goes into
  `free_list` and the function returns `true`. Otherwise the id goes into `free_blocks_in_use`, and the handle
  reference is dropped with the lock released, because the destructor may call back into `UnregisterBlock`.
- **`UnregisterBlock(id)`** (`:1429-1440`) is reached from `~BlockHandle` → `UnregisterPersistentBlock`
  (`block_manager.cpp:135-142`). It moves the id from `free_blocks_in_use` to `free_list`. This is how a block freed
  by a checkpoint, while a reader still holds the old version, becomes reusable once the last handle is gone.

### 8.4 Free-list serialization (inside `WriteHeader`)

**Reserving space.** `GetFreeListBlocks` (`:1246-1278`) loops until the reserved space suffices. Each iteration
estimates

```
8 + 8 × |free_list ∪ modified ∪ free_blocks_in_use ∪ newly_used|   (upper bound)
+ 8 + 12 × |multi_use_blocks|
+ 8 + 16 × MetadataManager::BlockCount()
```

against the reserved `allocated_size`, adds one `AllocateHandle()` (capacity `sub_size − 8`) per iteration, and
re-estimates. It re-estimates because allocating can itself add a metadata block. These reserved handles are fed to
`FreeListBlockWriter` (`:1280-1298`), which never allocates (`NextHandle` throws when it runs out). The free list is
therefore never written into blocks that it is itself describing.

**On-disk format.** The chain of metadata sub-blocks starts at `header.free_list` (`:1349-1364`):

```
u64              n_free
i64 × n_free     free block ids  (ascending: std::set order)
u64              n_multi
(i64 id, u32 count) × n_multi   — packed, 12 bytes each, unordered_map order
u64              n_metadata_blocks                        (MetadataManager::Write)
(i64 block_id, u64 free_sub_block_mask) × n_metadata_blocks
```

**What goes into the written free list** (`:1332-1342`):

- `free_list`
- **∪ `modified_blocks`** (`checkpoint_freed_blocks`)
- **∪ `newly_used_blocks`**. The source comment says "newly used blocks are still free blocks for this checkpoint".
  They are also removed from `written_multi_use_blocks`.
- At `fb38af476a7`, **`free_blocks_in_use` is not included**. The CLI branch adds it (section 11).

If `free_list_blocks` is empty, `header.free_list = INVALID_INDEX` (`:1365-1368`). In practice at least one sub-block
is always reserved, because the metadata-block section alone is ≥ 8 bytes.

### 8.5 When blocks freed during the next round become reusable

```
event                                         in-memory location        reusable for writes?
──────────────────────────────────────────────────────────────────────────────────────────────
block written by optimistic append            newly_used_blocks          no (in use)
  … transaction rolls back                    → free_list (directly)     YES, immediately   (8.3 step 3)
  … transaction commits (WAL row-group data)  removed from newly_used    no (implicitly used)
block referenced by durable header, dropped   modified_blocks            NO
  … WriteHeader(k+1): header fsynced (:1410)  → free_list                YES (after :1416)
                         or, if a BlockHandle still lives,
                                              → free_blocks_in_use       not yet
                         … last handle destroyed (UnregisterBlock)
                                              → free_list                YES
multi-use block, one reference dropped        multi_use_blocks count--   no
```

**The exact boundary.** A block that the durable header references moves from `modified_blocks` to `free_list`
**only after the second `Sync()`** in `WriteHeader` (`:1410` → `:1411-1420`). The checkpoint only processes the
snapshot `checkpoint_freed_blocks` taken at `:1333`. Blocks marked modified *during* `WriteHeader` stay in
`modified_blocks` for the next round.

### 8.6 Reload: `LoadFreeList`

`LoadFreeList` (`:870-892`) runs at open, right after `Initialize` (`:718`). It is **not** called after a checkpoint,
because the in-memory sets are already correct by then.

1. Construct `MetaBlockPointer(free_list_id, 0)`. If it is invalid, return (`:871-875`).
2. Use a `MetadataReader` with `REGISTER_BLOCKS`, so the free-list sub-blocks' metadata blocks get registered
   (`:876`).
3. Replace `free_list` with the stored ids and `multi_use_blocks` with the stored counts (`:877-889`).
4. `MetadataManager::Read`: register every metadata block and set its free-sub-block mask (`:890`).
5. `MetadataManager::MarkBlocksAsModified()`: every occupied sub-block is now "modified", i.e. freeable at the next
   checkpoint unless reused (`:891`).

Because the header serialized `modified_blocks ∪ newly_used_blocks` as free, a reopened database starts with all of
those in `free_list`. A crash therefore never leaks blocks that were in the modified state.

### 8.7 `Truncate`

`SingleFileBlockManager::Truncate` (`:1222-1244`) is called after `WriteHeader` and the optional verification
(`checkpoint_manager.cpp:333`).

1. Walk `free_list` from the top while `id + 1 == max_block`, decrementing `max_block` (`:1226-1234`).
2. If nothing can be trimmed, return (`:1235-1238`).
3. Erase those ids from `free_list` (`:1240`).
4. Truncate the file to `BLOCK_START + max_block × A` (`:1241-1242`, `DatabaseHandle::Truncate`
   `database_handle.cpp:142-149`).

Consequences:

- Only a **contiguous run of free blocks at the end** is removed. A single used block at the end prevents all
  truncation. Metadata blocks are often allocated last, so they often block it (section 10.7, file `t.db`).
- The durable header written just before still says `block_count = old max_block`, and its free list still lists the
  truncated ids. After reopen, `max_block` is the old count and the ids past EOF are in `free_list`. Writing such a
  block simply extends the file. Section 10.7 (`t2.db`) shows a 274,432-byte file (12288 + 1 block) whose header says
  `block_count = 15` with free list `[1..14]`.
- The DatabaseHeader comment describes blocks *after* `block_count` as implicitly free (`storage_info.hpp:384-385`).
  Truncation creates the converse case: blocks inside `block_count` but past EOF.

### 8.8 `VerifyBlocks` (debug)

When `debug_verify_blocks` is set, `CreateCheckpoint` collects the reference count of every block reachable from the
catalog and from metadata (`checkpoint_manager.cpp:298-326`). `VerifyBlocks` (`single_file_block_manager.cpp:1013-1101`)
then checks:

- every block is `< max_block`
- multi-use counts match
- used blocks are not in `free_list`
- `|referenced ∪ newly_used ∪ free_list ∪ free_blocks_in_use| == max_block`, i.e. no block is leaked

### 8.9 Punching holes: `TrimFreeBlocks`

`TrimFreeBlocks` (`:1449-1469`) is called with the blocks that were moved directly into `free_list` at
`WriteHeader` (`:1421-1422`). It is a no-op unless `DBConfigOptions::trim_free_blocks` is set. That option defaults to
`false` (`src/include/duckdb/main/config.hpp:109`) and is not exposed as a SQL setting at this commit.

When it is set, contiguous runs are passed to `TrimFreeBlockRange`, which calls `handle->Trim(offset, length)`
(`:1442-1447`). On Linux that is `fallocate(FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE)`. Verifier builds instead
write zeros (`src/common/local_file_system.cpp:559-578`). This is the only path that destroys the contents of a freed
block. Otherwise freed blocks keep their old bytes, and their old checksum, until reused.

### 8.10 Timeline across two checkpoints

These are the actual runs from section 10, with `A = 262144`. Ids are block ids.

```
T0  CREATE (CreateNewDatabase)                        file = 12288 B
    disk: h1{it0, root −1, fl −1, bc 0}, h2{same}; active=h2
    mem : free_list ∅, max_block 0

T1  CREATE TABLE t AS … 300k rows; CHECKPOINT (iteration 1)
    data: blocks 0..5 taken from max_block (0→6), either by the optimistic writer (GetFreeBlockId)
          or by the checkpoint (GetFreeBlockIdForCheckpoint); which one was not traced.
          Block 5 is a partial block shared by 3 segments → multi_use_blocks{5:3}
    meta: AllocateNewBlock → block 6; sub 0 catalog, sub 1 table metadata, sub 2 free list (reserved)
    WriteHeader: MarkBlocksAsModified (modified map empty) → then modified={6: subs 0,1,2}
          free list written: n_free 0 | multi [(5,3)] | metablocks [(6, mask 0xFFFF…F8)]
          Flush block 6 → Sync#1 → write h1{it1, root 0x…06, fl 0x02…06, bc 7} → Sync#2
    disk: h1 active (it1); file = 12288 + 7·A = 1,847,296 B

T2  (new process) LoadFreeList: free_list ∅, multi {5:3}; metadata block 6 mask F8;
    MarkBlocksAsModified → metadata modified={6: 0,1,2}
    CREATE TABLE u (1000 rows); DROP TABLE t   (commit → CommitDropState → MarkBlockAsModified 0..5;
                                               duck_transaction.cpp:283, duck_table_entry.cpp:1479-1480)
          0..4 → modified_blocks; 5: 3→2→1 (erased from multi) → 3rd call → modified_blocks
    CHECKPOINT (iteration 2)
    data: free_list is EMPTY (0..5 only "modified") → u's data goes to max_block → block 7
    meta: subs 3 (catalog), 4 (table) in block 6; GetFreeListBlocks → sub 5
    WriteHeader: MarkBlocksAsModified → subs 0,1,2 freed in memory; modified={6: 3,4,5}
          all_free = ∅ ∪ modified{0..5} → written [0,1,2,3,4,5], multi [], metablocks [(6, 0xFFFF…C7)]
          Flush block 6 (in place) → Sync#1 → write h2{it2, root 0x03…06, fl 0x05…06, bc 8} → Sync#2
          → modified 0..5 → free_list {0..5}  (now reusable)
          Truncate: max used block is 7 → nothing trimmed
    disk: h2 active (it2); h1 still it1; file 2,109,440 B; pragma: total 8, used 2, free 6
```

The `free_list` was empty while `u` was being written, even though `t` had already been dropped. So `u` could not
reuse blocks 0-5 and the file grew by one block. That is the "reusable only after the next durable header" rule
showing up in real allocations.

---

## 9. Encryption effects on layout (summary)

| Aspect | Plain | Encrypted |
|---|---|---|
| MainHeader | layout of 3.3, `flags[0]=0`, encryption fields zero | Same layout, plain text, `flags[0]=1`, metadata/canary/IV/tag set (`:556-582`) |
| Default storage version | v2.0.0 (69, main header 999) | v1.5.0 unless explicit (`StorageOptions::SetEncryptionVersion`, `storage_manager.cpp:32-88`). Main header 68 |
| Block/header-page header | 8 B checksum | 40 B: nonce ‖ tag ‖ 4 zero ‖ enc(checksum) (6.3) |
| h1/h2 pages | plain | encrypted. The active header cannot be determined without the key |
| Usable block size | A − 8 | A − 40 |
| Metadata sub-block size (256 KiB) | 4088 | 4088 (floor(262104/64)=4095 → 4088) |
| IO mode | any | MMAP is demoted to BUFFERED_IO (`storage_manager.cpp:431-439`) |
| Temp-file buffers | — | own 32-byte header, `DEFAULT_ENCRYPTED_BUFFER_HEADER_SIZE` (`storage_info.hpp:46`, `encryption_functions.cpp:152-170`) |
| WAL | `WAL_VERSION_NUMBER` 2 | encrypted WAL version (`src/storage/write_ahead_log.cpp:262-267`) |

The file offsets of blocks do not change: `BLOCK_START + id × A` in both cases.

## 9b. WAL relationship (brief)

- The WAL is a separate file `<db>.wal`. Its header records the WAL version, the 16-byte `db_identifier`, and the
  `checkpoint_iteration` (`write_ahead_log.cpp:262-283`). At replay these are checked against the database. The error
  is "WAL does not match database file." (`wal_replay.cpp:775-781`), and an iteration mismatch reports an older or
  newer WAL (`:753-759`).
- At checkpoint start, a CHECKPOINT entry with the planned root is appended and flushed, and new commits go to
  `<db>.wal.checkpoint` (`storage_manager.cpp:276-304`).
- After the header is durable and the file truncated, `WALFinishCheckpoint` either **deletes** `<db>.wal` and
  recreates it lazily (no concurrent writes), or **moves** `.wal.checkpoint` over `<db>.wal`
  (`storage_manager.cpp:307-336`). The WAL is thus removed or replaced, not truncated in place.
- Optimistically written row groups are stored in the database file, and the WAL refers to them by block id
  (`WriteRowGroupData`). That is why the free-list code has to handle WAL-referenced blocks (8.3 `MarkBlockAsUsed`).

---

## 10. Empirical validation

All commands were run in `/tmp/atlas-e03186bf` with `D=/Users/sgerrits/.duckdb/cli/latest/duckdb`
(v2.0.0-alpha49003, `b32b1368b8`). `-no-agent` disables the CLI's agent output mode.

### 10.1 Commands

```sh
$D -no-agent a.db -c "select 1"                                        # fresh file → 12288 bytes
$D -no-agent a.db -c "create table t as select i, 'str'||i s from range(300000) r(i); checkpoint;"
cp a.db a_ckpt1.db
$D -no-agent a.db -c "create table u as select i from range(1000) r(i); drop table t; checkpoint;"
cp a.db a_ckpt2.db
xxd -a -l 12288 a_ckpt1.db
```

### 10.2 Fresh file (`select 1` only), first 12 KiB, all-zero lines omitted

```
00000000: 3021 440e 91dd 39be 4455 434b e703 0000  0!D...9.DUCK....
00000030: 0000 0000 7632 2e30 2e30 2d61 6c70 6861  ....v2.0.0-alpha
00000040: 3439 3030 3300 0000 0000 0000 0000 0000  49003...........
00000050: 0000 0000 6233 3262 3133 3638 6238 0000  ....b32b1368b8..
00000070: 0000 0000 0000 0000 0000 0000 09f0 e805  ................
00000080: 8447 ddee 3a3a 32db 660b 8cff 0000 0000  .G..::2.f.......
00001000: f786 fa1f 2530 1415 0000 0000 0000 0000  ....%0..........      ← h1 (fresh)
00001010: ffff ffff ffff ffff ffff ffff ffff ffff  ................
00001020: 0000 0000 0000 0000 0000 0400 0000 0000  ................
00001030: 0008 0000 0000 0000 4500 0000 0000 0000  ........E.......
00001040: 3439 3030 3300 0000 0000 0000 0000 0000  49003...........      ← stale MainHeader bytes (4.6)
00001050: 0000 0000 6233 3262 3133 3638 6238 0000  ....b32b1368b8..
00001070: 0000 0000 0000 0000 0000 0000 09f0 e805  ................
00001080: 8447 ddee 3a3a 32db 660b 8cff 0000 0000  .G..::2.f.......
00002000: f786 fa1f 2530 1415 …   (h2 identical to h1)
```

### 10.3 After checkpoint 1 (`a_ckpt1.db`, 1,847,296 bytes = 12288 + 7·262144)

```
00000000: 3021 440e 91dd 39be 4455 434b e703 0000  0!D...9.DUCK....
          └ checksum be39dd910e442130 ┘ └DUCK┘ └ version_number = 0x3e7 = 999 …
00000010: 0000 0000 0000 0000 0000 0000 0000 0000
          … ┘ └ flags[0] = 0 (not encrypted)    … flags[1..3] = 0 through 0x33
00000030: 0000 0000 7632 2e30 2e30 2d61 6c70 6861  ....v2.0.0-alpha     @52 library version
00000040: 3439 3030 3300 0000 0000 0000 0000 0000  49003...........
00000050: 0000 0000 6233 3262 3133 3638 6238 0000  ....b32b1368b8..     @84 source id
00000070: 0000 0000 0000 0000 0000 0000 09f0 e805       @116 enc-metadata = 0 ×8; @124 db_identifier …
00000080: 8447 ddee 3a3a 32db 660b 8cff 0000 0000       … = 09f0e8058447ddee3a3a32db660b8cff; @140 canary 0
00000090: 0000 …                                        @148 iv 0, @160 tag 0, rest 0
*
00001000: 6e9a deae 8aef 755b 0100 0000 0000 0000  h1: checksum 5b75ef8aaede9a6e | iteration = 1
00001010: 0600 0000 0000 0000 0600 0000 0000 0002      meta_block = 0x6 (blk 6, sub 0) | free_list = 0x0200000000000006 (blk 6, sub 2)
00001020: 0700 0000 0000 0000 0000 0400 0000 0000      block_count = 7 | block_alloc_size = 0x40000 = 262144
00001030: 0008 0000 0000 0000 4500 0000 0000 0000      vector_size = 2048 | storage version = 0x45 = 69 (v2.0.0)
00001040: 0000 …  (clean: header_buffer.Clear() at single_file_block_manager.cpp:1386)
00002000: f786 fa1f 2530 1415 0000 0000 0000 0000  h2: still the fresh it0 header (+ stale bytes)
```

Block 6 (metadata) starts at `12288 + 6·262144 = 1,585,152 = 0x183000`:

```
00183000: 956d 41aa 3f46 5ffe ffff ffff ffff ffff   block checksum fe5f463faa416d95 | sub 0 next = −1 (end of chain)
00183010: 6400 0263 0002 6400 0164 0002 6900 006f   sub 0 data: BinarySerializer field ids (catalog_entries)
```

Free-list sub-block = sub 2 at `0x183000 + 8 + 2·4088 = 1,593,336 = 0x184FF8`:

```
00184ff8: ffff ffff ffff ffff 0000 0000 0000 0000   next = −1 | n_free = 0
00185008: 0100 0000 0000 0000 0500 0000 0000 0000   n_multi = 1 | id = 5
00185018: 0300 0000 0100 0000 0000 0000 0600 0000   count = 3 (u32) | n_metadata_blocks = 1 | block_id = 6 …
00185028: 0000 0000 f8ff ffff ffff ffff 0000 0000   … | free mask = 0xFFFFFFFFFFFFFFF8 (subs 0,1,2 used)
```

`PRAGMA metadata_info` reported block 6 with 61 free sub-blocks `[3..63]`, which matches the mask.
`pragma_database_size()` reported total 7, used 7, free 0.

### 10.4 After checkpoint 2 (`a_ckpt2.db`, 2,109,440 bytes = 12288 + 8·262144)

```
00001000: 6e9a deae 8aef 755b 0100 …    h1 unchanged (iteration 1)
00002000: 62d1 96a6 aeee 3677 0200 0000 0000 0000   h2: checksum 7736eeaea696d162 | iteration 2
00002010: 0600 0000 0000 0003 0600 0000 0000 0005       meta_block = blk 6 sub 3 | free_list = blk 6 sub 5
00002020: 0800 0000 0000 0000 0000 0400 0000 0000       block_count = 8 | 262144
00002030: 0008 0000 0000 0000 4500 0000 0000 0000       2048 | 69
```

Free-list sub-block 5 at `0x187FE0`:

```
00187fe0: ffff ffff ffff ffff 0600 0000 0000 0000   next −1 | n_free = 6
00187ff0: 0000 0000 0000 0000 0100 0000 0000 0000   0, 1
00188000: 0200 0000 0000 0000 0300 0000 0000 0000   2, 3
00188010: 0400 0000 0000 0000 0500 0000 0000 0000   4, 5
00188020: 0000 0000 0000 0000 0100 0000 0000 0000   n_multi = 0 | n_metadata_blocks = 1
00188030: 0600 0000 0000 0000 c7ff ffff ffff ffff   block 6 | mask 0xFFFFFFFFFFFFFFC7 (subs 3,4,5 used; 0,1,2 free)
```

- Sub-blocks 0-2 of block 6 are byte-identical in both files, which confirms the in-place rewrite (7.7). The block
  checksum changed from `fe5f463faa416d95` to `dda87cf999104467`.
- `pragma_database_size()` reported total 8, used 2, free 6. `u` went into the new block 7, because blocks 0-5 were
  still only modified while `u` was being written (8.10).

**Crash before the header** (`debug_checkpoint_abort='before_header'` on a copy, `c.db`):

- The checkpoint failed with `FATAL Error: … Checkpoint aborted before header write`.
- h1 and h2 were unchanged and `c.db.wal` was 967 bytes.
- Reopen replayed the WAL (`count(*) = 500000`) and the next checkpoint wrote **iteration 3 to h1**
  (`meta_block 0x1`, `free_list 0x0200000000000001`).

### 10.5 Corrupting the older header

```sh
cp a_ckpt2.db corrupt.db; printf '\x99' | dd of=corrupt.db bs=1 seek=4196 conv=notrunc
$D -no-agent corrupt.db -c "select count(*) from u"
# Data Corruption Error: Corrupt database file: computed checksum 2285757249695423086 does not match
#   stored checksum 6590437008644938350 in block at location 4096
```

h2 (iteration 2) was intact, yet the file could not be opened (5.4).

### 10.6 Encrypted file and a 16 KiB-block file

```sh
$D -no-agent -c "ATTACH 'e.db' AS e (ENCRYPTION_KEY 'secret'); create table e.t as select i from range(1000) r(i); checkpoint e;
                 ATTACH 's.db' AS s (BLOCK_SIZE 16384); create table s.t as select i from range(1000) r(i); checkpoint s;"
```

`e.db` (536,576 B = 12288 + 2·262144):

```
00000000: 41fb 22d2 ed21 4abe 4455 434b 4400 0000   checksum (plain) | DUCK | version_number = 0x44 = 68 (v1.5.0)
00000010: 0000 0000 0100 0000 0000 0000 0000 0000   flags[0] = 1  ← ENCRYPTED_DATABASE_FLAG
00000070: 0000 0000 0100 0101 2000 0000 8836 fd1b   @116 enc-meta: kdf=1(SHA256) aad=0 cipher=1(GCM) ver=1(V0_1) keylen=0x20
00000080: cfd6 f15e c036 182c 2934 6e0a 129a 7074   @124 db_identifier/salt 8836fd1b…6e0a | @140 encrypted canary 129a7074…
00000090: f9cf a36f c20c f211 4a8d 7cd8 cf32 6b25   … f9cfa36f | @148 canary IV (12 B) c20cf211 4a8d7cd8 cf326b25
000000a0: 0c9f 2f10 b6ce a615 2263 f241 59ad ea63   @160 canary GCM tag (16 B)
00001000: fc96 0759 9858 a1a5 7ca6 f32e d9b8 8ffb   h1: nonce (12 B) fc960759 9858a1a5 7ca6f32e | tag …
00001010: d740 06a8 8eca 2773 513d f658 0000 0000   … d9b88ffb d74006a8 8eca2773 513df658 | 4 zero pad
00001020: 5812 1c29 2506 dc2d 973d d18d aca5 7169   @32 encrypted checksum | @40 encrypted DatabaseHeader …
```

`s.db` (45,056 B = 12288 + 2·16384): h1 is `{iteration 1, meta_block 0x0, free_list 0x0300000000000000, block_count 2,
block_alloc_size 16384, vector_size 2048, storage 69}`. Sub-block size 248, free-list sub-block at
`12288 + 8 + 3·248 = 13040`, metadata mask `0xFFFFFFFFFFFFFFF0` (subs 0-3 used). The table metadata spilled over more
sub-blocks than with 256 KiB blocks.

### 10.7 Truncation

```sh
# t.db: create keep (tiny) + big (200k rows); checkpoint; drop big; checkpoint
#   → 3,944,448 B before and after: metadata block 14 is the last block, so no trailing free run.
# t2.db: create keep; checkpoint; create big; checkpoint; drop big; checkpoint
#   → 274,432 B → 3,944,448 B → 274,432 B (12288 + 1 block)
#   h1 {iteration 3, meta_block 0x0, free_list 0x0200000000000000, block_count 15}
#   free list = [1..14], metadata blocks [(0, 0xFFFFFFFFFFFFFFF8)]; reopen: total_blocks 15, free_blocks 14
```

### 10.7b Older format, for comparison (v1.5.6, default storage v0.10.2)

`o.db`: `version_number = 64`, `db_identifier` all zero (storage < v1.4.0), h1 storage field `1` (deprecated
serialization version for v0.10.2). v1.5.6 refuses `a.db` with "Trying to read a database file with version number
69, but we can only read versions between 64 and 68."

### 10.8 Decoder used (also reimplements `Checksum`)

```python
import struct, sys
M64 = (1 << 64) - 1
def checksum(buf):                      # src/common/checksum.cpp:67-79 (8-byte-multiple inputs)
    r = 5381
    for i in range(len(buf) // 8):
        r ^= (struct.unpack_from('<Q', buf, 8 * i)[0] * 0xbf58476d1ce4e5b9) & M64
    return r
def u64(b, o): return struct.unpack_from('<Q', b, o)[0]
d = open(sys.argv[1], 'rb').read()
mh = d[0:4096]
print('main stored %016x computed %016x' % (u64(mh, 0), checksum(mh[8:])))
print('magic', mh[8:12], 'version', u64(mh, 12), 'flags', [u64(mh, 20 + 8 * i) for i in range(4)])
print('desc', mh[52:84].rstrip(b'\0'), 'hash', mh[84:116].rstrip(b'\0'), 'encmeta', mh[116:124].hex(),
      'dbid', mh[124:140].hex(), 'canary', mh[140:148].hex(), 'iv', mh[148:160].hex(), 'tag', mh[160:176].hex())
for n, off in (('h1', 4096), ('h2', 8192)):          # plain files only (block_header_size 8)
    h = d[off:off + 4096]
    names = ['iteration', 'meta_block', 'free_list', 'block_count', 'block_alloc_size', 'vector_size', 'storage']
    print(n, 'stored %016x computed %016x' % (u64(h, 0), checksum(h[8:])),
          dict(zip(names, [hex(u64(h, 8 + 8 * i)) for i in range(7)])))
```

Results:

- Stored and computed checksums matched for the MainHeader, h1, h2, and all 7 blocks of `a_ckpt1.db`. For example,
  block 0 is `c92f5a1bf0b9f8b2` and block 6 is `fe5f463faa416d95`.
- `checksum(4088 zero bytes) = 0x1505`.

---

## 11. Version caveats (source `fb38af476a7` vs CLI `b32b1368b8`)

`git diff fb38af476a7 b32b1368b8` over the relevant files shows the following:

| Area | `fb38af476a7` (documented) | CLI branch | Format impact |
|---|---|---|---|
| Persisted free list | `all_free_blocks = free_list ∪ modified ∪ newly_used` (`:1332-1342`). **`free_blocks_in_use` omitted**, so a block parked there while a header is written is recorded as used and is permanently lost space after a restart | also inserts `free_blocks_in_use` | none (content only) |
| `block_count` capture | read after `metadata_manager.Flush` with the lock re-acquired (`:1369-1374`) | read under the lock before `Flush` | none |
| `Truncate` | truncates only if trailing free blocks were found (`:1235-1243`) | also truncates when the file is larger than `BLOCK_START + max_block·A`, e.g. after a crash | none |
| `UnregisterBlock` | `BlockManager::UnregisterBlock` then the lock (`:1429-1440`) | lock held across both. Adds `UnregisterExpiredBlock` | none |
| `MetadataManager::Pin` / `ConvertToTransient` | single pin attempt (`metadata_manager.cpp:102-128`) | retry loop. Old handle set to `DestroyBufferUpon::EVICTION` | none |
| Version error text | "version number" | "storage version number". Unknown DB-header versions above 69 produce the same message | none |

The exact field offsets, header alternation, block geometry, metadata encoding, and free-list format are the same in
both trees. Section 10 confirms them against the CLI.

---

## 12. Observations recorded as beans

| Bean | Finding | Evidence |
|---|---|---|
| `repos-shfp` | A checksum failure in the *inactive* DatabaseHeader makes the database unopenable; there is no fallback to the other header | `single_file_block_manager.cpp:699-716`; section 10.5 |
| `repos-9ftg` (draft) | Metadata blocks holding live sub-blocks of the durable checkpoint are rewritten in place. A torn write could invalidate that block's checksum for the old checkpoint | `metadata_manager.cpp:54-96`, `:277-313`; section 10.4 |
| `repos-1nmp` | `RewriteMainHeader` → `ConstructMainHeader` leaves `db_identifier` (and other arrays) uninitialized and serializes them. It also drops flags/encryption fields and is called without `skip_block_header` | `single_file_block_manager.cpp:417-422`, `:860-868`, `storage_info.hpp:363-370`. Upgrading a v1.1.3 file with `STORAGE_VERSION 'v1.2.0'` wrote `db_identifier = 0f4b6d0100000008b8dd040100000030`, which looks like pointer bytes, and main version 65 |

---

## 13. Invariants (summary)

1. **Layout.** The file is `[MainHeader 4 KiB][h1 4 KiB][h2 4 KiB][block 0][block 1]…`. Block *i* is at
   `12288 + i·block_alloc_size`, and `block_alloc_size ∈ {16, 32, 64, 128, 256} KiB` is fixed for the file's lifetime
   (stored in each DatabaseHeader).
2. **Page header.** Every page except the MainHeader has `block_header_size` header bytes (8 plain, 40 encrypted). The
   u64 checksum sits at byte `block_header_size − 8` and covers `[block_header_size, page_end)`. The MainHeader always
   has its checksum at byte 0 covering `[8, 4096)` and is never encrypted.
3. **MainHeader.** `"DUCK"` at byte 8. The version at byte 12 is 999 for storage ≥ v2.0.0 and otherwise 64..68.
   Encryption is `flags[0] & 1`. Bytes 116-175 hold the encryption metadata, db_identifier/salt, canary, IV, and tag.
   The MainHeader is written once, except for explicit version up- or downgrades.
4. **Active header.** The active header is the DatabaseHeader with the larger `iteration`, and h2 wins a tie. Both
   pages must pass their checksums. A checkpoint writes `iteration+1` to the *inactive* page, so odd iterations live
   in h1 and even ones in h2.
5. **Durability ordering.** All data and metadata blocks are written, then fsynced, then the header page is written,
   then fsynced again. The new state exists only once that second fsync has completed.
6. **Writes avoid durable state.** Between checkpoints and during a checkpoint, new data goes only to ids in
   `free_list` (free in the durable header) or `≥ max_block`. The single exception is the in-place rewrite of
   partially reused **metadata** blocks (7.7).
7. **Freeing.** A block referenced by the durable header becomes reusable only after the *next* header is fsynced
   (`modified_blocks → free_list`). A block that no header has referenced yet (in `newly_used_blocks`) is reusable as
   soon as it is freed. A block with a live `BlockHandle` waits in `free_blocks_in_use` until the handle dies. A
   multi-use block is freed only when its reference count drops to 1 and that last reference is dropped.
8. **Persisted free list.** The free list written with header *k+1* lists `free_list ∪ modified_blocks ∪
   newly_used_blocks` (plus `free_blocks_in_use` on the CLI branch), the multi-use counts, and every metadata block's
   free-sub-block mask. It is stored in metadata sub-blocks reserved before it is serialized.
9. **Implicit use.** A block id `< block_count` that is not in the persisted free list is in use, with reference count
   1 unless it appears in the multi-use list. Ids `≥ block_count` are free. Ids in the free list may lie past EOF
   after truncation.
10. **Metadata addressing.** `MetaBlockPointer.block_pointer = block_id | sub_index << 56`, with `sub_index < 64`. The
    sub-block size is `floor8((A − header)/64)` (4088 for 256 KiB). Each sub-block begins with an 8-byte next pointer,
    where `−1` ends the chain, and data starts at offset 8.
11. **Metadata reuse.** Sub-blocks occupied by checkpoint *k* are freed at `WriteHeader(k+1)` unless checkpoint
    *k+1* reuses them (`ClearModifiedBlocks`). A metadata block whose sub-blocks are all free is handed back to the
    block free list through `MarkBlockAsModified`.
12. **Truncation.** It happens only after a durable header, and only for a contiguous run of free ids at the end of
    the file. The header is not rewritten to reflect the smaller file.
13. **WAL.** `<db>.wal` is separate. A checkpoint marker containing the planned root decides at recovery whether the
    WAL is already reflected in the file (`IsRootBlock`). After a successful checkpoint the WAL is deleted, or
    replaced by `.wal.checkpoint`.
