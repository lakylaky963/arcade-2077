// WILDCARD // 2077 card art: our own SVG (chamfered neon cards, shape pips for colour-blind players).
// Not Uno artwork: no Uno name, logo, typeface, oval or colour layout. Pure string builders (no DOM) so they run in tests.

export const CARD_W = 100;
export const CARD_H = 150;

export const COLOR_HEX = Object.freeze({ red: '#ff2a55', yellow: '#fcee09', green: '#00ff9f', blue: '#00b4ff' });
const INK = '#07080d';
const CUT = 12;
const SHAPE = Object.freeze({ red: 'tri', yellow: 'dot', green: 'sq', blue: 'dia' });
const PLAIN = '#161926';

const OUTLINE = `${CUT},0 ${CARD_W},0 ${CARD_W},${CARD_H - CUT} ${CARD_W - CUT},${CARD_H} 0,${CARD_H} 0,${CUT}`;

function pip(shape, cx, cy, r, fill) {
  switch (shape) {
    case 'tri': return `<polygon points="${cx},${cy - r} ${cx + r},${cy + r * .8} ${cx - r},${cy + r * .8}" fill="${fill}"/>`;
    case 'dot': return `<circle cx="${cx}" cy="${cy}" r="${r * .9}" fill="${fill}"/>`;
    case 'sq': return `<rect x="${cx - r * .85}" y="${cy - r * .85}" width="${r * 1.7}" height="${r * 1.7}" fill="${fill}"/>`;
    case 'dia': return `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" fill="${fill}"/>`;
    default: return '';
  }
}

const CORNER = { number: (v) => v, skip: () => '⊘', reverse: () => '⇄', draw2: () => '+2', wild: () => '', wild_draw4: () => '+4' };

function wedges(cx, cy, r) {
  const hex = [COLOR_HEX.red, COLOR_HEX.yellow, COLOR_HEX.green, COLOR_HEX.blue];
  // four quarter-diamond wedges around (cx, cy)
  const pts = [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
  return hex.map((h, i) => {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    return `<polygon points="${cx},${cy} ${a[0]},${a[1]} ${b[0]},${b[1]}" fill="${h}"/>`;
  }).join('');
}

function glyph(card, fg) {
  const cx = CARD_W / 2;
  const cy = CARD_H / 2;
  switch (card.value) {
    case 'skip':
      return `<circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="${fg}" stroke-width="9"/><line x1="${cx - 18}" y1="${cy + 18}" x2="${cx + 18}" y2="${cy - 18}" stroke="${fg}" stroke-width="9"/>`;
    case 'reverse':
      return `<g fill="${fg}"><path d="M30 62 h34 v-12 l22 20 -22 20 v-12 h-34z"/><path d="M70 100 h-34 v12 l-22 -20 22 -20 v12 h34z" transform="translate(0 -4)"/></g>`;
    case 'draw2':
      return `<g><rect x="30" y="48" width="30" height="42" fill="none" stroke="${fg}" stroke-width="5" transform="rotate(-10 45 69)"/><rect x="42" y="56" width="30" height="42" fill="${fg}" transform="rotate(8 57 77)"/></g><text x="${cx}" y="${cy + 38}" text-anchor="middle" font-size="26" font-weight="800" fill="${fg}" font-family="var(--mono), monospace">+2</text>`;
    case 'wild':
      return wedges(cx, cy, 32);
    case 'wild_draw4':
      return `${wedges(cx, cy - 6, 28)}<text x="${cx}" y="${cy + 46}" text-anchor="middle" font-size="26" font-weight="800" fill="#f0f2fa" font-family="var(--mono), monospace">+4</text>`;
    default:
      return `<text x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="68" font-weight="800" fill="${fg}" font-family="var(--mono), monospace">${card.value}</text>`;
  }
}

/**
 * One face-up card. `opts.chosen` (a colour) rings a wild that was played; `opts.label` is the accessible name.
 * The root <svg> has class "wc-card-svg" and a data-color so CSS can glow it.
 */
export function cardSVG(card, opts = {}) {
  const wild = card.kind === 'wild';
  const fill = wild ? PLAIN : COLOR_HEX[card.color] || PLAIN;
  const fg = wild ? '#f0f2fa' : INK;
  const small = wild ? '' : (CORNER[['skip', 'reverse', 'draw2'].includes(card.value) ? card.value : 'number'](card.value));
  const shape = wild ? '' : SHAPE[card.color] || '';
  const ring = wild && opts.chosen && COLOR_HEX[opts.chosen]
    ? `<polygon points="${OUTLINE}" fill="none" stroke="${COLOR_HEX[opts.chosen]}" stroke-width="7"/>` : '';
  const corner = wild
    ? (card.value === 'wild_draw4' ? `<text x="9" y="22" font-size="14" font-weight="800" fill="${fg}" font-family="var(--mono), monospace">+4</text>` : '')
    : `<text x="9" y="22" font-size="15" font-weight="800" fill="${fg}" font-family="var(--mono), monospace">${small}</text>${pip(shape, 17, 36, 6, fg)}`;
  const cornerLow = wild ? '' : `<g transform="rotate(180 ${CARD_W / 2} ${CARD_H / 2})"><text x="9" y="22" font-size="15" font-weight="800" fill="${fg}" font-family="var(--mono), monospace">${small}</text>${pip(shape, 17, 36, 6, fg)}</g>`;
  const label = opts.label ? ` role="img" aria-label="${escapeAttr(opts.label)}"` : ' aria-hidden="true"';
  return `<svg class="wc-card-svg" data-color="${wild ? 'wild' : card.color}" viewBox="0 0 ${CARD_W} ${CARD_H}" xmlns="http://www.w3.org/2000/svg"${label}>`
    + `<polygon points="${OUTLINE}" fill="${fill}" stroke="${wild ? '#39405a' : 'rgba(0,0,0,.45)'}" stroke-width="2"/>`
    + (wild ? '' : `<polygon points="14,${CUT + 14} ${CARD_W - 14},${CUT + 14} ${CARD_W - 14},${CARD_H - CUT - 14} 14,${CARD_H - CUT - 14}" fill="rgba(7,8,13,.08)"/>`)
    + glyph(card, fg) + corner + cornerLow + ring + `</svg>`;
}

/** A face-down card (opponents, draw pile). */
export function cardBackSVG(opts = {}) {
  const label = opts.label ? ` role="img" aria-label="${escapeAttr(opts.label)}"` : ' aria-hidden="true"';
  return `<svg class="wc-card-svg" data-color="back" viewBox="0 0 ${CARD_W} ${CARD_H}" xmlns="http://www.w3.org/2000/svg"${label}>`
    + `<polygon points="${OUTLINE}" fill="#0e1019" stroke="#39405a" stroke-width="2"/>`
    + `<polygon points="14,${CUT + 14} ${CARD_W - 14},${CUT + 14} ${CARD_W - 14},${CARD_H - CUT - 14} 14,${CARD_H - CUT - 14}" fill="none" stroke="var(--accent, #fcee09)" stroke-width="2" opacity=".7"/>`
    + `<g opacity=".9">${wedges(CARD_W / 2, CARD_H / 2, 20)}</g>`
    + `<text x="${CARD_W / 2}" y="${CARD_H - 22}" text-anchor="middle" font-size="9" letter-spacing="2" fill="#7e86a3" font-family="var(--mono), monospace">WC//77</text></svg>`;
}

/** A small round swatch for the colour picker and the active-colour chip (shape pip included). */
export function colorSwatchSVG(color) {
  const fill = COLOR_HEX[color] || '#7e86a3';
  return `<svg viewBox="0 0 40 40" width="28" height="28" aria-hidden="true"><rect x="2" y="2" width="36" height="36" rx="6" fill="${fill}"/>${pip(SHAPE[color], 20, 20, 9, INK)}</svg>`;
}

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

/** Accessible card name for a language table (see i18n.js): "red 7", "blue skip", "wild draw four". */
export function cardName(card, tr) {
  const word = (v) => (/^\d$/.test(v) ? v : tr(`c_${v}`));
  if (card.kind === 'wild') return tr(`c_${card.value}`);
  return `${tr(`col_${card.color}`)} ${word(card.value)}`;
}
