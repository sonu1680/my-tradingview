'use client';

import { formatServerTime } from '@/components/chart/useCandleData';
import type { CountSummary, CountedTrade } from '@/lib/counter/types';

/**
 * The Count-mode log as a printable report — "Export PDF".
 *
 * No PDF library. Every browser can already render a page to PDF, so the
 * report is built as a self-contained HTML document, written into a hidden
 * same-origin iframe, and printed; the user picks "Save as PDF" in the print
 * dialog. That keeps the dependency list empty and the output selectable,
 * searchable text rather than a bitmap.
 *
 * An iframe rather than `window.open`: a popup blocker can swallow a new
 * window even on a click, and this way nothing steals a tab.
 *
 * The report is styled for PAPER — dark ink on white — rather than reusing the
 * terminal palette, which would print as a solid black rectangle and drain a
 * cartridge for no benefit.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Every value goes through this: a trade `reason` is free text. */
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function num(value: number | undefined, digits: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value: number | undefined, digits: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * The parent's stylesheets, copied in so `@font-face` resolves.
 *
 * `next/font` self-hosts Ubuntu and injects its `@font-face` rules into the
 * app's own stylesheets; without them the iframe would silently fall back to a
 * system font and the report would not match the app.
 */
function inheritedStyles(): string {
  const parts: string[] = [];
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    parts.push(node.outerHTML);
  }
  return parts.join('\n');
}

/** The resolved family names, so the report uses the same faces as the app. */
function families(): { sans: string; mono: string } {
  const root = getComputedStyle(document.documentElement);
  const sans = root.getPropertyValue('--font-sans-ui').trim();
  const mono = root.getPropertyValue('--font-mono-ui').trim();
  return {
    sans: sans === '' ? 'Ubuntu, system-ui, sans-serif' : `${sans}, Ubuntu, sans-serif`,
    mono: mono === '' ? '"Ubuntu Mono", ui-monospace, monospace' : `${mono}, ui-monospace, monospace`,
  };
}

const OUTCOME_LABEL: Record<string, string> = {
  win: 'win',
  loss: 'loss',
  open: 'open',
  expired: 'expired',
  never_triggered: 'not triggered',
  invalid: 'invalid',
};

function summaryCards(summary: CountSummary): string {
  const cards: Array<[string, string, string]> = [
    ['Trades', String(summary.total), `${summary.decided} decided`],
    ['Win rate', `${summary.winRate.toFixed(1)}%`, `${summary.wins}W / ${summary.losses}L`],
    ['Total pips', signed(summary.totalPips, 0), `avg ${signed(summary.avgPips, 0)}`],
    ['Total R', signed(summary.totalR, 2), `expectancy ${signed(summary.expectancyR, 2)}R`],
    [
      'Avg planned R:R',
      summary.avgPlannedRR === null ? '—' : summary.avgPlannedRR.toFixed(2),
      'as drawn',
    ],
    [
      'Not scored',
      String(summary.open + summary.expired + summary.neverTriggered + summary.invalid),
      `${summary.open} open · ${summary.expired} exp · ${summary.neverTriggered} n/t · ${summary.invalid} inv`,
    ],
  ];
  return cards
    .map(
      ([label, value, hint]) => `
      <div class="card">
        <div class="card-label">${esc(label)}</div>
        <div class="card-value">${esc(value)}</div>
        <div class="card-hint">${esc(hint)}</div>
      </div>`,
    )
    .join('');
}

function rows(trades: readonly CountedTrade[]): string {
  if (trades.length === 0) {
    return '<tr><td colspan="12" class="empty">No trades logged.</td></tr>';
  }
  return trades
    .map((t) => {
      const outcome = OUTCOME_LABEL[t.outcome] ?? t.outcome;
      const tone =
        t.outcome === 'win' ? 'win' : t.outcome === 'loss' ? 'loss' : 'flat';
      return `
      <tr>
        <td class="mono">${esc(formatServerTime(t.loggedAt, true))}</td>
        <td>${esc(t.timeframe)}</td>
        <td>${esc(t.side)}</td>
        <td class="mono num">${esc(num(t.entry, 3))}</td>
        <td class="mono num">${esc(num(t.stop, 3))}</td>
        <td class="mono num">${esc(num(t.target, 3))}</td>
        <td class="mono num">${esc(t.plannedRR === null ? '—' : t.plannedRR.toFixed(2))}</td>
        <td class="${tone}">${esc(outcome)}</td>
        <td class="mono num ${tone}">${esc(signed(t.pips, 0))}</td>
        <td class="mono num ${tone}">${esc(signed(t.r, 2))}</td>
        <td class="mono num">${esc(t.minutesHeld === undefined ? '—' : String(t.minutesHeld))}</td>
        <td class="reason">${esc(t.reason ?? '')}</td>
      </tr>`;
    })
    .join('');
}

function reportHtml(
  symbol: string,
  trades: readonly CountedTrade[],
  summary: CountSummary,
): string {
  const { sans, mono } = families();
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(symbol)} — Count mode report</title>
${inheritedStyles()}
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ${sans};
    color: #14171c;
    background: #fff;
    font-size: 10pt;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { font-size: 16pt; margin: 0 0 2pt; font-weight: 700; letter-spacing: .01em; }
  .sub { font-size: 9pt; color: #5c636d; margin-bottom: 10pt; }
  .cards { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6pt; margin-bottom: 12pt; }
  .card { border: 0.6pt solid #c8ccd2; padding: 5pt 6pt; }
  .card-label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .1em; color: #5c636d; }
  .card-value { font-family: ${mono}; font-size: 14pt; font-weight: 700; line-height: 1.2; }
  .card-hint { font-size: 7.5pt; color: #5c636d; }
  table { width: 100%; border-collapse: collapse; }
  /* Repeat the header on every printed page. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th {
    text-align: left; font-size: 7.5pt; text-transform: uppercase;
    letter-spacing: .08em; color: #5c636d; border-bottom: 0.8pt solid #14171c;
    padding: 3pt 4pt; white-space: nowrap;
  }
  td { padding: 2.6pt 4pt; border-bottom: 0.4pt solid #e2e5e9; vertical-align: top; }
  .mono { font-family: ${mono}; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .win { color: #0a7a5a; }
  .loss { color: #c0392b; }
  .flat { color: #5c636d; }
  .reason { font-size: 8pt; color: #5c636d; max-width: 58mm; }
  .empty { padding: 10pt; color: #5c636d; text-align: center; }
  footer { margin-top: 10pt; font-size: 7.5pt; color: #5c636d; line-height: 1.5; }
</style>
</head>
<body>
  <h1>${esc(symbol)} — Count mode report</h1>
  <div class="sub">
    ${trades.length} trade${trades.length === 1 ? '' : 's'} ·
    generated ${esc(generated)} UTC ·
    all timestamps are broker server time, unshifted
  </div>

  <div class="cards">${summaryCards(summary)}</div>

  <table>
    <thead>
      <tr>
        <th>Drawn</th><th>TF</th><th>Side</th>
        <th class="num">Entry</th><th class="num">Stop</th><th class="num">Target</th>
        <th class="num">R:R</th><th>Outcome</th>
        <th class="num">Pips</th><th class="num">R</th><th class="num">Mins</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>${rows(trades)}</tbody>
  </table>

  <footer>
    Win rate is over wins and losses only. <strong>Open</strong> trades have not
    reached a level yet and carry no P&amp;L. <strong>Not triggered</strong> means
    price never reached the entry — nothing was risked, so it is not a loss.
    <strong>Invalid</strong> means the box is not a trade (stop or target on the
    wrong side of entry). Pips and R total over win, loss and expired.
  </footer>
</body>
</html>`;
}

/**
 * Build the report and open the print dialog.
 *
 * Returns false when the document cannot be written (the iframe was blocked),
 * so the caller can tell the user rather than appearing to do nothing.
 */
export function printCountReport(
  symbol: string,
  trades: readonly CountedTrade[],
  summary: CountSummary,
): boolean {
  if (typeof document === 'undefined') return false;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = 'Count mode report';
  // Off-screen rather than display:none — a hidden frame does not lay out, and
  // some engines then print a blank page.
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;';
  document.body.appendChild(frame);

  const remove = () => {
    if (frame.parentNode !== null) frame.parentNode.removeChild(frame);
  };

  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (doc === null || win === null) {
      remove();
      return false;
    }

    doc.open();
    doc.write(reportHtml(symbol, trades, summary));
    doc.close();

    // Give the copied stylesheets (and the webfont) a frame to apply, or the
    // report prints in a fallback face.
    win.addEventListener('afterprint', remove);
    setTimeout(() => {
      win.focus();
      win.print();
      // `afterprint` is not fired by every engine; this is the backstop.
      setTimeout(remove, 60_000);
    }, 250);
    return true;
  } catch {
    remove();
    return false;
  }
}
