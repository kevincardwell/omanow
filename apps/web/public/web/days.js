import { el } from "./meetups.js";

const $ = (id) => document.getElementById(id);
const DAY_MS = 86_400_000;
const WEEKS = 53;
const LABEL_GAP = 3;

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const fmt = new Intl.NumberFormat();
const machines = (n) => `${fmt.format(n)} ${n === 1 ? "machine" : "machines"}`;

function dayGrid(days) {
  const counts = new Map(days);
  const max = Math.max(1, ...counts.values());
  const now = new Date();
  const last = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS;
  const start = last - (new Date(last).getUTCDay() + (WEEKS - 1) * 7) * DAY_MS;

  const grid = el("div", { className: "days" });
  grid.style.setProperty("--weeks", WEEKS);
  for (const [day, label] of [[1, "mon"], [3, "wed"], [5, "fri"]]) {
    grid.append(el("span", { className: "weekday", textContent: label, style: `grid-area: ${day + 2} / 1` }));
  }
  let labelled = -LABEL_GAP;
  for (let t = start, i = 0; t <= last; t += DAY_MS, i++) {
    const date = new Date(t);
    const col = Math.floor(i / 7) + 2;
    if (date.getUTCDate() <= 7 && date.getUTCDay() === 0 && col - labelled >= LABEL_GAP) {
      grid.append(el("span", { className: "month", textContent: monthFmt.format(date), style: `grid-area: 1 / ${col} / 2 / span ${LABEL_GAP}` }));
      labelled = col;
    }
    const n = counts.get(date.toISOString().slice(0, 10)) || 0;
    const level = n ? Math.min(4, Math.ceil((4 * n) / max)) : 0;
    const tip = `${dayFmt.format(date)} · ${n ? machines(n) : "none"}`;
    const cell = el("i", { className: `l${level}`, title: tip, style: `grid-area: ${date.getUTCDay() + 2} / ${col}` });
    cell.dataset.tip = tip;
    grid.append(cell);
  }

  const detail = el("p", { className: "detail", textContent: " " });
  const show = (e) => e.target.dataset.tip && (detail.textContent = e.target.dataset.tip);
  grid.addEventListener("pointerover", show);
  grid.addEventListener("click", show);
  const legend = el("p", { className: "legend" }, "less ", ...[0, 1, 2, 3, 4].map((l) => el("i", { className: `l${l}` })), " more");
  return { wrap: el("div", { className: "days-wrap" }, grid), detail, legend };
}

export function createHistoryUi() {
  const dialog = $("history");
  const body = $("history-body");

  async function open() {
    body.replaceChildren(el("p", { className: "fine", textContent: "loading…" }));
    dialog.showModal();
    try {
      const res = await fetch("api/history");
      if (!res.ok) throw new Error(res.statusText);
      render((await res.json()).days || []);
    } catch {
      body.replaceChildren(el("p", { className: "fine", textContent: "History is unavailable." }));
    }
  }

  function render(days) {
    const { wrap, detail, legend } = dayGrid(days);
    body.replaceChildren(wrap, el("div", { className: "days-foot" }, detail, legend));
    wrap.scrollLeft = wrap.scrollWidth;
  }

  $("history-open").addEventListener("click", open);
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
}
