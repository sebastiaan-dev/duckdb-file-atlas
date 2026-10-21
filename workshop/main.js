import Reveal from 'reveal.js';
import Markdown from 'reveal.js/plugin/markdown/markdown.esm.js';
import Notes from 'reveal.js/plugin/notes/notes.esm.js';
import Highlight from 'reveal.js/plugin/highlight/highlight.esm.js';
import 'reveal.js/dist/reveal.css';
import './theme.css';
import slides from './slides.md?raw';

const artwork = {
  'duckdb-logo': new URL('./assets/duckdb-logo.png', import.meta.url).href,
  'column-file': new URL('./assets/column-file.png', import.meta.url).href,
  'write-data': new URL('./assets/write-data.png', import.meta.url).href,
  processor: new URL('./assets/processor.png', import.meta.url).href,
  inspect: new URL('./assets/inspect.png', import.meta.url).href,
  maintenance: new URL('./assets/maintenance.png', import.meta.url).href,
  lightbulb: new URL('./assets/lightbulb.png', import.meta.url).href,
  'inspect-file': new URL('./assets/inspect-file.png', import.meta.url).href,
};

// Resolve authored asset references before Markdown parsing, so Vite fingerprints
// and bundles the images even though the slide source is imported as raw text.
document.querySelector('#workshop-content').textContent = slides.replace(
  /asset:([a-z-]+)/g,
  (_, name) => {
    if (!artwork[name]) throw new Error(`Unknown workshop artwork: ${name}`);
    return artwork[name];
  },
);
const deck = new Reveal({
  plugins: [Markdown, Notes, Highlight],
  hash: true,
  history: true,
  // Keynote-style chrome: no on-screen arrows or progress bar; the footer carries the page number.
  controls: false,
  progress: false,
  slideNumber: false,
  transition: 'none',
  backgroundTransition: 'none',
  width: 1600,
  height: 900,
  margin: 0,
  center: false,
  disableLayout: false,
  pdfSeparateFragments: false,
  // Markdown supports raw HTML, intentionally: diagrams are authored locally.
  markdown: { smartypants: true },
});
deck.initialize().then(() => {
  const pages = deck.getSlides();
  pages.forEach((slide, index) => {
    if (slide.classList.contains('cover-slide')) return;
    const footer = document.createElement('footer');
    footer.className = 'slide-footer';
    footer.setAttribute('aria-hidden', 'true');
    for (const text of ['DuckDB File Atlas', 'Workshop', 'Inside a DuckDB file', `${index + 1}`]) {
      const label = document.createElement('span');
      label.textContent = text;
      footer.append(label);
    }
    footer.lastElementChild.className = 'page-number';
    slide.append(footer);
  });
  deck.layout();
  // A small stable hook for browser smoke checks, not an app dependency.
  window.workshopDeck = deck;
});
