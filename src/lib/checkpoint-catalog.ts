import {
  BinaryReader,
  readBlockPointer,
  readMetaPointer,
  safeInteger,
  type MetaPointer,
} from "./binary-reader";

/** Logical type information needed to interpret each table's column tree. */
export interface LogicalType {
  id: number;
  name: string;
  children?: { name: string; type: LogicalType }[];
  width?: number;
  scale?: number;
  arraySize?: number;
  enumValues?: string[];
}

export interface CatalogColumn {
  name: string;
  type: LogicalType;
}
export interface IndexStorage {
  name: string;
  root: bigint;
  allocatorInfos: {
    segmentSize: number;
    blockPointers: { blockId: number; offset: number }[];
  }[];
}
export interface CatalogTable {
  name: string;
  columns: CatalogColumn[];
  pointer: MetaPointer;
  totalRows: number;
  indexes: IndexStorage[];
}

const CATALOG_TYPES = {
  TABLE: 1,
  SCHEMA: 2,
  VIEW: 3,
  INDEX: 4,
  SEQUENCE: 6,
  TYPE: 8,
  MACRO: 30,
  TABLE_MACRO: 31,
} as const;

const TYPE_NAMES: Record<number, string> = {
  0: "INVALID",
  1: "SQLNULL",
  2: "UNKNOWN",
  3: "ANY",
  4: "UNBOUND",
  5: "TEMPLATE",
  6: "TYPE",
  10: "BOOLEAN",
  11: "TINYINT",
  12: "SMALLINT",
  13: "INTEGER",
  14: "BIGINT",
  15: "DATE",
  16: "TIME",
  17: "TIMESTAMP_S",
  18: "TIMESTAMP_MS",
  19: "TIMESTAMP",
  20: "TIMESTAMP_NS",
  21: "DECIMAL",
  22: "FLOAT",
  23: "DOUBLE",
  24: "CHAR",
  25: "VARCHAR",
  26: "BLOB",
  27: "INTERVAL",
  28: "UTINYINT",
  29: "USMALLINT",
  30: "UINTEGER",
  31: "UBIGINT",
  32: "TIMESTAMP_TZ",
  33: "TIMESTAMP_TZ_NS",
  34: "TIME_TZ",
  35: "TIME_NS",
  36: "BIT",
  37: "STRING_LITERAL",
  38: "INTEGER_LITERAL",
  39: "BIGNUM",
  49: "UHUGEINT",
  50: "HUGEINT",
  51: "POINTER",
  53: "VALIDITY",
  54: "UUID",
  60: "GEOMETRY",
  100: "STRUCT",
  101: "LIST",
  102: "MAP",
  103: "TABLE",
  104: "ENUM",
  105: "LEGACY_AGGREGATE_STATE",
  106: "LAMBDA",
  107: "UNION",
  108: "ARRAY",
  109: "VARIANT",
  110: "TUPLE",
};

function fail(message: string): never {
  throw new Error(`Unsupported revision-69 catalog data: ${message}`);
}
function optionalString(reader: BinaryReader, id: number): string {
  return reader.optional(id) ? reader.string() : "";
}
function optionalUnsigned(reader: BinaryReader, id: number): bigint {
  return reader.optional(id) ? reader.unsigned() : 0n;
}
function optionalBool(reader: BinaryReader, id: number): boolean {
  return reader.optional(id) ? reader.bool() : false;
}
function optionalList<T>(reader: BinaryReader, id: number, read: () => T): T[] {
  return reader.optional(id) ? reader.list(() => read()) : [];
}
function requiredList<T>(reader: BinaryReader, id: number, read: () => T): T[] {
  reader.field(id);
  return reader.list(() => read());
}
function readStringList(reader: BinaryReader): string[] {
  return reader.list(() => reader.string());
}
function readPair<K, V>(
  reader: BinaryReader,
  readKey: () => K,
  readValue: () => V,
): [K, V] {
  return reader.object(() => {
    reader.field(0);
    const key = readKey();
    reader.field(1);
    return [key, readValue()];
  });
}
function readStringMap<T>(
  reader: BinaryReader,
  readValue: () => T,
): Map<string, T> {
  return new Map(
    reader.list(() => readPair(reader, () => reader.string(), readValue)),
  );
}
function readStringMapOptional<T>(
  reader: BinaryReader,
  id: number,
  readValue: () => T,
): Map<string, T> {
  return reader.optional(id) ? readStringMap(reader, readValue) : new Map();
}
function readNullableObject<T>(reader: BinaryReader, read: () => T): T | null {
  return reader.nullable(() => reader.object(read));
}

/** Decode the root catalog stream. Each catalog item is a field-ID object inside the field-100 list. */
export function decodeCatalog(reader: BinaryReader): CatalogTable[] {
  const entries = reader.object(() => {
    reader.field(100);
    return reader.list(() => reader.object(() => readCatalogEntry(reader)));
  });
  // Metadata streams are supplied as complete allocated slots, so zero or stale
  // bytes may follow the root object's 0xFFFF terminator. The object terminator
  // is the authoritative end of the catalog payload.
  return entries.filter((entry): entry is CatalogTable => entry !== null);
}

function readCatalogEntry(reader: BinaryReader): CatalogTable | null {
  reader.field(99);
  const type = reader.uint();
  switch (type) {
    case CATALOG_TYPES.TABLE:
      return readTableEntry(reader);
    case CATALOG_TYPES.SCHEMA:
      readSchemaEntry(reader);
      return null;
    case CATALOG_TYPES.TYPE:
      readTypeEntry(reader);
      return null;
    case CATALOG_TYPES.SEQUENCE:
      readSequenceEntry(reader);
      return null;
    case CATALOG_TYPES.INDEX:
      readIndexEntry(reader);
      return null;
    case CATALOG_TYPES.VIEW:
      readViewEntry(reader);
      return null;
    case CATALOG_TYPES.MACRO:
    case CATALOG_TYPES.TABLE_MACRO:
      readMacroEntry(reader, type);
      return null;
    default:
      fail(`catalog type ${type} has no decoder`);
  }
}

interface CreateInfoBase {
  qualifiedPath: string[];
}
function readCreateInfoBase(
  reader: BinaryReader,
  expectedType: number,
): CreateInfoBase {
  reader.field(100);
  const actualType = reader.uint();
  if (actualType !== expectedType)
    fail(
      `CreateInfo type ${actualType} does not match catalog type ${expectedType}`,
    );

  // Catalog/schema were emitted before v2.0 only. Reading their optional slots preserves forward parsing.
  if (reader.optional(101)) reader.string();
  if (reader.optional(102)) reader.string();
  if (reader.optional(103)) reader.bool();
  if (reader.optional(104)) reader.bool();
  reader.field(105);
  reader.uint(); // OnCreateConflict
  if (reader.optional(106)) reader.string();
  if (reader.optional(107)) readValue(reader);
  readStringMapOptional(reader, 108, () => reader.string());
  if (reader.optional(109)) readLogicalDependencyList(reader);
  if (reader.optional(110)) reader.string();
  const qualifiedPath = reader.optional(111) ? readQualifiedName(reader) : [];
  return { qualifiedPath };
}

function readQualifiedName(reader: BinaryReader): string[] {
  return reader.object(() => {
    const path = reader.optional(100) ? readStringList(reader) : [];
    return path;
  });
}

function readLogicalDependencyList(reader: BinaryReader): void {
  reader.object(() => {
    reader.field(100);
    reader.list(() =>
      reader.object(() => {
        reader.field(100);
        reader.object(() => {
          reader.field(100);
          reader.uint(); // CatalogType
          if (reader.optional(101)) reader.string(); // legacy schema
          if (reader.optional(102)) reader.string();
          if (reader.optional(103)) readStringList(reader);
          if (reader.optional(104)) reader.string();
        });
        if (reader.optional(101)) reader.string();
        if (reader.optional(102))
          reader.object(() => {
            if (reader.optional(100)) reader.uint();
          });
      }),
    );
  });
}

function readTableEntry(reader: BinaryReader): CatalogTable {
  reader.field(100);
  const info = reader.nullable(() =>
    reader.object(() => {
      const base = readCreateInfoBase(reader, CATALOG_TYPES.TABLE);
      const localName = optionalString(reader, 200);
      reader.field(201);
      const columns = reader
        .object(() =>
          optionalList(reader, 100, () => readColumnDefinition(reader)),
        )
        .filter((column): column is CatalogColumn => column !== null);
      const constraints = optionalList(reader, 202, () =>
        readConstraintPointer(reader),
      );
      if (constraints.some((constraint) => constraint === null))
        fail("null table constraint");
      if (reader.optional(203)) {
        const query = readNullableObject(reader, () =>
          fail("CREATE TABLE query payload"),
        );
        if (query) fail("CREATE TABLE query payload");
      }
      const partitionKeys = optionalList(reader, 204, () =>
        readParsedExpressionPointer(reader),
      );
      const sortKeys = optionalList(reader, 205, () =>
        readParsedExpressionPointer(reader),
      );
      if (
        partitionKeys.some((item) => item === null) ||
        sortKeys.some((item) => item === null)
      ) {
        fail("null partition or sort expression");
      }
      readStringMapOptional(reader, 206, () =>
        readParsedExpressionPointer(reader),
      );
      return { qualifiedPath: base.qualifiedPath, localName, columns };
    }),
  );
  if (!info) fail("table entry has a null CreateInfo pointer");

  reader.field(101);
  const pointer = readMetaPointer(reader);
  reader.field(102);
  const totalRows = reader.uint();
  reader.field(103);
  reader.list(() => readBlockPointer(reader)); // obsolete v1 index block pointers, empty in v69
  reader.field(104);
  const indexes = reader.list(() => readIndexStorageInfo(reader));
  reader.field(105);
  reader.uint(); // next_row_id; totalRows remains the row group count source used by the scanner

  const tableName = info.localName || info.qualifiedPath.at(-1) || "";
  const pathParts =
    info.qualifiedPath.length > 1 ? info.qualifiedPath.slice(1) : [tableName];
  const pathName = pathParts.map(displayIdentifier).join(".");
  if (!tableName) fail("table has no name");
  return {
    name: pathName || tableName,
    columns: info.columns,
    pointer,
    totalRows,
    indexes,
  };
}

export function displayIdentifier(identifier: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(identifier)) return identifier;
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readColumnDefinition(reader: BinaryReader): CatalogColumn | null {
  return reader.object(() => {
    const name = optionalString(reader, 100);
    reader.field(101);
    const type = readLogicalType(reader);
    if (reader.optional(102)) {
      const expression = readParsedExpressionPointer(reader);
      if (expression === null) fail("null column expression marker");
    }
    reader.field(103);
    const category = reader.uint(); // STANDARD or GENERATED
    reader.field(104);
    reader.uint(); // CompressionType
    if (reader.optional(105)) readValue(reader);
    readStringMapOptional(reader, 106, () => reader.string());
    if (!name) fail("column has no name");
    if (category !== 0 && category !== 1)
      fail(`table column category ${category}`);
    return category === 0 ? { name, type } : null;
  });
}

function readConstraintPointer(reader: BinaryReader): number | null {
  return reader.nullable(() =>
    reader.object(() => {
      reader.field(100);
      const type = reader.uint();
      switch (type) {
        case 1: // NOT NULL
          reader.field(200);
          reader.unsigned();
          break;
        case 2: // CHECK
          if (reader.optional(200)) {
            const expr = readParsedExpressionPointer(reader);
            if (expr === null) fail("null CHECK expression");
          }
          break;
        case 3: // UNIQUE / PRIMARY KEY
          if (reader.optional(200)) reader.bool();
          reader.field(201);
          reader.unsigned();
          if (reader.optional(202)) readStringList(reader);
          if (reader.optional(203)) reader.uint();
          break;
        case 4: // FOREIGN KEY
          if (reader.optional(200)) readStringList(reader);
          if (reader.optional(201)) readStringList(reader);
          reader.field(202);
          reader.uint();
          if (reader.optional(203)) reader.string();
          if (reader.optional(204)) reader.string();
          if (reader.optional(205)) reader.list(() => reader.unsigned());
          if (reader.optional(206)) reader.list(() => reader.unsigned());
          break;
        default:
          fail(`constraint type ${type}`);
      }
      return type;
    }),
  );
}

function readSchemaEntry(reader: BinaryReader): void {
  reader.field(100);
  const result = reader.nullable(() =>
    reader.object(() => {
      readCreateInfoBase(reader, CATALOG_TYPES.SCHEMA);
      if (reader.optional(200))
        readStringMap(reader, () => readParsedExpressionPointer(reader));
    }),
  );
  if (result === null) fail("schema entry has a null CreateInfo pointer");
}

function readTypeEntry(reader: BinaryReader): void {
  reader.field(100);
  const result = reader.nullable(() =>
    reader.object(() => {
      readCreateInfoBase(reader, CATALOG_TYPES.TYPE);
      if (reader.optional(200)) reader.string();
      reader.field(201);
      readLogicalType(reader);
    }),
  );
  if (result === null) fail("type entry has a null CreateInfo pointer");
}

function readSequenceEntry(reader: BinaryReader): void {
  reader.field(100);
  const result = reader.nullable(() =>
    reader.object(() => {
      readCreateInfoBase(reader, CATALOG_TYPES.SEQUENCE);
      if (reader.optional(200)) reader.string();
      if (reader.optional(201)) reader.unsigned();
      if (reader.optional(202)) reader.signed();
      if (reader.optional(203)) reader.signed();
      if (reader.optional(204)) reader.signed();
      if (reader.optional(205)) reader.signed();
      if (reader.optional(206)) reader.bool();
      if (reader.optional(207)) reader.nullable(() => reader.signed());
    }),
  );
  if (result === null) fail("sequence entry has a null CreateInfo pointer");
}

function readIndexEntry(reader: BinaryReader): void {
  reader.field(100);
  const result = reader.nullable(() =>
    reader.object(() => {
      readCreateInfoBase(reader, CATALOG_TYPES.INDEX);
      if (reader.optional(200)) reader.string();
      if (reader.optional(201)) reader.string();
      // 202 DeprecatedIndexType was deleted and is not emitted by v69.
      reader.field(203);
      reader.uint();
      optionalList(reader, 204, () => readParsedExpressionPointer(reader));
      optionalList(reader, 205, () => readLogicalType(reader));
      optionalList(reader, 206, () => reader.string());
      optionalList(reader, 207, () => reader.unsigned());
      readStringMapOptional(reader, 208, () => readValue(reader));
      if (reader.optional(209)) reader.string();
    }),
  );
  if (result === null) fail("index entry has a null CreateInfo pointer");
  if (reader.optional(101)) readBlockPointer(reader); // legacy root pointer
}

function readViewEntry(reader: BinaryReader): void {
  reader.field(100);
  const result = reader.nullable(() =>
    reader.object(() => {
      readCreateInfoBase(reader, CATALOG_TYPES.VIEW);
      if (reader.optional(200)) reader.string();
      optionalList(reader, 201, () => reader.string());
      optionalList(reader, 202, () => readLogicalType(reader));
      if (reader.optional(203)) {
        const query = readNullableObject(reader, () =>
          readSelectStatement(reader),
        );
        if (query === null) fail("view has a null query pointer");
      }
      optionalList(reader, 204, () => reader.string());
      if (reader.optional(206)) readStringMap(reader, () => readValue(reader));
      if (reader.optional(207)) reader.uint();
    }),
  );
  if (result === null) fail("view entry has a null CreateInfo pointer");
}

function readMacroEntry(reader: BinaryReader, catalogType: number): void {
  reader.field(100);
  const result = reader.nullable(() =>
    reader.object(() => {
      readCreateInfoBase(reader, catalogType);
      if (reader.optional(200)) reader.string();
      if (reader.optional(201)) {
        const functionInfo = reader.nullable(() =>
          reader.object(() => readMacroFunction(reader, catalogType)),
        );
        if (functionInfo === null) fail("macro has a null function pointer");
      }
      const extraFunctions = optionalList(reader, 202, () =>
        reader.nullable(() =>
          reader.object(() => readMacroFunction(reader, catalogType)),
        ),
      );
      if (extraFunctions.some((item) => item === null))
        fail("macro has a null overload pointer");
    }),
  );
  if (result === null) fail("macro entry has a null CreateInfo pointer");
}

function readMacroFunction(reader: BinaryReader, catalogType: number): void {
  reader.field(100);
  const macroType = reader.uint();
  optionalList(reader, 101, () => readParsedExpressionPointer(reader));
  readStringMapOptional(reader, 102, () => readParsedExpressionPointer(reader));
  optionalList(reader, 103, () => readLogicalType(reader));
  if (catalogType === CATALOG_TYPES.MACRO && macroType !== 2)
    fail(`scalar macro has macro type ${macroType}`);
  if (catalogType === CATALOG_TYPES.TABLE_MACRO && macroType !== 1)
    fail(`table macro has macro type ${macroType}`);
  if (macroType === 2) {
    if (reader.optional(200)) {
      const expression = readParsedExpressionPointer(reader);
      if (expression === null) fail("scalar macro has a null expression");
    }
    return;
  }
  if (macroType === 1) {
    if (reader.optional(200)) {
      const query = readNullableObject(reader, () => readQueryNode(reader));
      if (query === null) fail("table macro has a null query");
    }
    return;
  }
  fail(`macro function type ${macroType}`);
}

function readSelectStatement(reader: BinaryReader): void {
  if (reader.optional(100)) {
    const node = readNullableObject(reader, () => readQueryNode(reader));
    if (node === null) fail("SELECT statement has a null query node");
  }
  if (reader.optional(101)) readStringMap(reader, () => reader.unsigned());
}

function readQueryNode(reader: BinaryReader): void {
  reader.field(100);
  const queryType = reader.uint();
  optionalList(reader, 101, () => readResultModifierPointer(reader));
  reader.field(102);
  reader.object(() => {
    if (reader.optional(100)) fail("query CTE map is unsupported");
  });
  if (queryType !== 1) fail(`query node type ${queryType}`);

  optionalList(reader, 200, () => readParsedExpressionPointer(reader));
  if (reader.optional(201)) readTableRefPointer(reader);
  if (reader.optional(202)) readParsedExpressionPointer(reader);
  optionalList(reader, 203, () => readParsedExpressionPointer(reader));
  if (reader.optional(204))
    reader.list(() => reader.list(() => reader.unsigned()));
  reader.field(205);
  reader.uint(); // AggregateHandling
  if (reader.optional(206)) readParsedExpressionPointer(reader);
  if (reader.optional(207)) {
    const sample = reader.nullable(() => fail("SELECT sample options"));
    if (sample !== null) fail("SELECT sample options");
  }
  if (reader.optional(208)) readParsedExpressionPointer(reader);
}

function readTableRefPointer(reader: BinaryReader): void {
  const tableRef = reader.nullable(() =>
    reader.object(() => {
      reader.field(100);
      const tableType = reader.uint();
      if (reader.optional(101)) reader.string();
      if (reader.optional(102)) {
        const sample = reader.nullable(() => fail("table sample options"));
        if (sample !== null) fail("table sample options");
      }
      if (reader.optional(103)) reader.unsigned(); // optional_idx query location
      if (reader.optional(104)) reader.uint();
      if (tableType === 1) {
        if (reader.optional(200)) reader.string();
        if (reader.optional(201)) reader.string();
        optionalList(reader, 202, () => reader.string());
        if (reader.optional(203)) reader.string();
        if (reader.optional(204)) {
          const atClause = reader.nullable(() =>
            reader.object(() => {
              if (reader.optional(1)) reader.string();
              if (reader.optional(2)) readParsedExpressionPointer(reader);
            }),
          );
          if (atClause === null) fail("base table has a null AT clause");
        }
        if (reader.optional(205)) readQualifiedName(reader);
        return true;
      }
      if (tableType === 8) return true; // EMPTY_FROM
      fail(`table reference type ${tableType}`);
    }),
  );
  if (tableRef === null) fail("SELECT has a null table reference pointer");
}

function readResultModifierPointer(reader: BinaryReader): void {
  const modifier = reader.nullable(() =>
    reader.object(() => {
      reader.field(100);
      const type = reader.uint();
      switch (type) {
        case 1: // LIMIT
        case 4: // legacy LIMIT PERCENT
          if (reader.optional(200)) readParsedExpressionPointer(reader);
          if (reader.optional(201)) readParsedExpressionPointer(reader);
          if (type === 1 && reader.optional(202)) reader.uint();
          break;
        case 2: // ORDER BY
          if (reader.optional(200))
            reader.list(() =>
              reader.object(() => {
                reader.field(100);
                reader.uint();
                reader.field(101);
                reader.uint();
                if (reader.optional(102)) readParsedExpressionPointer(reader);
              }),
            );
          break;
        case 3: // DISTINCT
          optionalList(reader, 200, () => readParsedExpressionPointer(reader));
          break;
        default:
          fail(`result modifier type ${type}`);
      }
    }),
  );
  if (modifier === null) fail("query has a null result modifier");
}

function readIndexStorageInfo(reader: BinaryReader): IndexStorage {
  return reader.object(() => {
    const name = optionalString(reader, 100);
    const root = optionalUnsigned(reader, 101);
    const allocatorInfos = reader.optional(102)
      ? reader.list(() => readFixedSizeAllocatorInfo(reader))
      : [];
    readStringMapOptional(reader, 103, () => readValue(reader));
    return { name, root, allocatorInfos };
  });
}

function readFixedSizeAllocatorInfo(
  reader: BinaryReader,
): IndexStorage["allocatorInfos"][number] {
  return reader.object(() => {
    const segmentSize = reader.optional(100) ? reader.uint() : 0;
    if (reader.optional(101)) reader.list(() => reader.unsigned());
    const blockPointers = reader.optional(102)
      ? reader.list(() => readBlockPointer(reader))
      : [];
    if (reader.optional(103)) reader.list(() => reader.unsigned());
    if (reader.optional(104)) reader.list(() => reader.unsigned());
    if (reader.optional(105)) reader.list(() => reader.unsigned());
    return { segmentSize, blockPointers };
  });
}

export function readLogicalType(reader: BinaryReader): LogicalType {
  return reader.object(() => {
    reader.field(100);
    const id = reader.uint();
    const info = reader.optional(101)
      ? reader.nullable(() => reader.object(() => readLogicalTypeInfo(reader)))
      : null;
    const name = TYPE_NAMES[id] ?? `TYPE_${id}`;
    const result: LogicalType = { id, name };
    if (info) Object.assign(result, info);
    return result;
  });
}

interface TypeInfo {
  children?: { name: string; type: LogicalType }[];
  width?: number;
  scale?: number;
  arraySize?: number;
  enumValues?: string[];
  alias?: string;
}
function readLogicalTypeInfo(reader: BinaryReader): TypeInfo {
  reader.field(100);
  const type = reader.uint();
  const alias = optionalString(reader, 101);
  // Field 102 was deleted; no bytes are written for it by v69.
  if (reader.optional(103))
    readNullableObject(reader, () => readExtensionTypeInfo(reader));
  const info: TypeInfo = {};
  switch (type) {
    case 1: // generic
    case 8: // legacy aggregate state
      break;
    case 2:
      info.width = reader.optional(200) ? reader.uint() : 18;
      info.scale = reader.optional(201) ? reader.uint() : 3;
      if (
        info.width < 1 ||
        info.width > 38 ||
        info.scale < 0 ||
        info.scale > info.width
      ) {
        fail(`invalid DECIMAL(${info.width}, ${info.scale}) type`);
      }
      break;
    case 3:
      if (reader.optional(200)) reader.string(); // collation
      break;
    case 4:
      reader.field(200);
      info.children = [{ name: "item", type: readLogicalType(reader) }];
      break;
    case 5:
      if (reader.optional(200)) {
        info.children = reader
          .list(() =>
            readPair(
              reader,
              () => reader.string(),
              () => readLogicalType(reader),
            ),
          )
          .map(([name, childType]) => ({ name, type: childType }));
      } else info.children = [];
      break;
    case 6: {
      reader.field(200);
      const count = reader.uint();
      reader.field(201);
      info.enumValues = readStringList(reader);
      if (info.enumValues.length !== count) fail("enum label count mismatch");
      break;
    }
    case 7:
      if (reader.optional(204)) {
        const expr = readParsedExpressionPointer(reader);
        if (expr === null) fail("null unbound type expression");
      }
      break;
    case 9:
      reader.field(200);
      info.children = [{ name: "item", type: readLogicalType(reader) }];
      info.arraySize = reader.optional(201) ? reader.uint() : 0;
      if (info.arraySize < 1 || info.arraySize > 100_000)
        fail(`invalid ARRAY size ${info.arraySize}`);
      break;
    case 10:
      reader.field(200);
      info.children = [{ name: "target", type: readLogicalType(reader) }];
      if (reader.optional(201)) reader.unsigned();
      break;
    case 11:
      reader.field(200);
      readValue(reader);
      break;
    case 12:
      if (reader.optional(200)) reader.string();
      break;
    case 13:
      reader.field(200);
      reader.object(() => {
        if (reader.optional(100)) reader.string();
      });
      break;
    default:
      fail(`logical type info kind ${type}`);
  }
  if (alias) info.alias = alias;
  return info;
}

function readExtensionTypeInfo(reader: BinaryReader): void {
  if (reader.optional(100))
    reader.list(() =>
      reader.object(() => {
        reader.field(100);
        readValue(reader);
        if (reader.optional(101)) reader.string();
      }),
    );
  if (reader.optional(101)) readStringMap(reader, () => readValue(reader));
}

function readValue(reader: BinaryReader, typeHint?: LogicalType): void {
  reader.object(() => readValueFields(reader, typeHint));
}

function readValueFields(reader: BinaryReader, typeHint?: LogicalType): void {
  const type = reader.optional(100) ? readLogicalType(reader) : typeHint;
  if (!type)
    fail("Value omitted its logical type and has no parent type context");
  reader.field(101);
  if (reader.bool()) return;
  if (type.id === 6) {
    reader.field(102);
    readLogicalType(reader);
    return;
  }
  reader.field(102);
  switch (type.id) {
    case 10:
      reader.bool();
      return;
    case 11:
    case 12:
    case 13:
    case 14:
    case 15:
    case 16:
    case 17:
    case 18:
    case 19:
    case 20:
    case 27:
      // Interval is also represented as a pair of integer LEB128 words in the value stream.
      if (type.id === 27) {
        reader.signed();
        reader.signed();
        reader.signed();
      } else reader.signed();
      return;
    case 21: {
      const width = type.width ?? 18;
      if (width <= 4) reader.signed();
      else if (width <= 9) reader.signed();
      else if (width <= 18) reader.signed();
      else {
        reader.signed();
        reader.unsigned();
      }
      return;
    }
    case 22:
      reader.f32();
      return;
    case 23:
      reader.f64();
      return;
    case 24:
    case 25:
    case 26:
    case 39:
    case 60:
      reader.string();
      if (type.id === 60 && reader.optional(103)) reader.uint();
      return;
    case 28:
    case 29:
    case 30:
    case 31:
      reader.unsigned();
      return;
    case 49:
    case 50:
    case 54:
      reader.signed();
      reader.unsigned();
      return;
    case 104:
      reader.unsigned();
      return;
    case 100:
    case 101:
    case 102:
    case 107:
    case 108:
    case 109:
    case 110: {
      const children = type.children ?? [];
      reader.object(() => {
        reader.field(100);
        const nestedCount = reader.uint();
        if (nestedCount > 1_000_000) fail("nested Value has too many children");
        for (let index = 0; index < nestedCount; index++) {
          const childType =
            type.id === 101 || type.id === 108
              ? children[0]?.type
              : type.id === 102
                ? children[index]?.type
                : children[index]?.type;
          reader.object(() => readValueFields(reader, childType));
        }
      });
      return;
    }
    default:
      fail(`Value storage type ${type.name}`);
  }
}

function readParsedExpressionPointer(reader: BinaryReader): number | null {
  return reader.nullable(() =>
    reader.object(() => readParsedExpression(reader)),
  );
}

function readOrderModifierPointer(reader: BinaryReader): void {
  reader.nullable(() =>
    reader.object(() => {
      reader.field(100);
      const type = reader.uint();
      if (type !== 2) fail(`function result modifier type ${type}`);
      if (reader.optional(200))
        reader.list(() =>
          reader.object(() => {
            reader.field(100);
            reader.uint(); // OrderType
            reader.field(101);
            reader.uint(); // OrderByNullType
            if (reader.optional(102)) readParsedExpressionPointer(reader);
          }),
        );
    }),
  );
}

function readParsedExpression(reader: BinaryReader): number {
  reader.field(100);
  const expressionClass = reader.uint();
  reader.field(101);
  reader.uint(); // ExpressionType
  if (reader.optional(102)) reader.string();
  if (reader.optional(103)) reader.unsigned();
  if (reader.optional(104)) reader.uint();
  switch (expressionClass) {
    case 2: // CASE
      if (reader.optional(200))
        reader.list(() =>
          reader.object(() => {
            if (reader.optional(100)) readParsedExpressionPointer(reader);
            if (reader.optional(101)) readParsedExpressionPointer(reader);
          }),
        );
      if (reader.optional(201)) readParsedExpressionPointer(reader);
      break;
    case 3: // CAST
      if (reader.optional(200)) readParsedExpressionPointer(reader);
      if (reader.optional(201)) readLogicalType(reader); // older v1.5 form
      if (reader.optional(202)) reader.bool();
      if (reader.optional(203)) readParsedExpressionPointer(reader);
      break;
    case 4: // COLUMN_REF
      if (reader.optional(200)) readStringList(reader);
      break;
    case 5: // COMPARISON
      if (reader.optional(200)) readParsedExpressionPointer(reader);
      if (reader.optional(201)) readParsedExpressionPointer(reader);
      break;
    case 6:
    case 10: // CONJUNCTION / OPERATOR
      optionalList(reader, 200, () => readParsedExpressionPointer(reader));
      break;
    case 7: // CONSTANT: v2.0 stores a source Literal instead of a typed Value.
      if (reader.optional(200)) readValue(reader);
      if (reader.optional(201))
        reader.object(() => {
          reader.field(100);
          reader.uint();
          if (reader.optional(101)) reader.string();
        });
      break;
    case 8: // DEFAULT
      break;
    case 9: // FUNCTION
      if (reader.optional(200)) reader.string();
      if (reader.optional(201)) reader.string();
      optionalList(reader, 202, () => readParsedExpressionPointer(reader)); // legacy argument form
      if (reader.optional(203)) readParsedExpressionPointer(reader);
      if (reader.optional(204)) readOrderModifierPointer(reader);
      if (reader.optional(205)) reader.bool();
      if (reader.optional(206)) reader.bool();
      if (reader.optional(207)) reader.bool();
      if (reader.optional(208)) reader.string();
      if (reader.optional(209))
        reader.list(() =>
          reader.object(() => {
            if (reader.optional(100)) reader.string();
            if (reader.optional(101)) readParsedExpressionPointer(reader);
          }),
        );
      if (reader.optional(210)) readQualifiedName(reader);
      break;
    case 11: // STAR
      if (reader.optional(200)) reader.string();
      if (reader.optional(201)) reader.list(() => reader.string());
      if (reader.optional(202)) fail("star replacement expressions");
      if (reader.optional(203)) reader.bool();
      if (reader.optional(204)) readParsedExpressionPointer(reader);
      if (reader.optional(205)) reader.bool();
      if (reader.optional(206)) fail("qualified star exclusions");
      if (reader.optional(207)) fail("qualified star renames");
      break;
    case 15: // PARAMETER
      if (reader.optional(200)) reader.string();
      break;
    case 16: // COLLATE
      if (reader.optional(200)) readParsedExpressionPointer(reader);
      if (reader.optional(201)) reader.string();
      break;
    case 18: // POSITIONAL_REFERENCE
      if (reader.optional(200)) reader.unsigned();
      break;
    case 19: // BETWEEN
      if (reader.optional(200)) readParsedExpressionPointer(reader);
      if (reader.optional(201)) readParsedExpressionPointer(reader);
      if (reader.optional(202)) readParsedExpressionPointer(reader);
      break;
    case 21: // TYPE
      if (reader.optional(200)) reader.string();
      if (reader.optional(201)) reader.string();
      if (reader.optional(202)) reader.string();
      optionalList(reader, 203, () => readParsedExpressionPointer(reader));
      if (reader.optional(204)) readQualifiedName(reader);
      break;
    default:
      fail(`parsed expression class ${expressionClass}`);
  }
  return expressionClass;
}
