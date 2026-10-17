import { CITY_BY_ID } from "../core/cities.js";
import { WAVES } from "../core/waves.js";
import { countryName, el } from "./meetups.js";

const $ = (id) => document.getElementById(id);

const ECHO_MS = 5000;
const TOAST_MS = 12_000;
const SPRITE = 11;

export function emojiSprites() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SPRITE;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.font = `${SPRITE - 1}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  return Object.fromEntries(
    [...WAVES].map(([kind, emoji]) => {
      g.clearRect(0, 0, SPRITE, SPRITE);
      g.fillText(emoji, SPRITE / 2, SPRITE / 2 + 1);
      return [kind, g.getImageData(0, 0, SPRITE, SPRITE)];
    }),
  );
}

const bump = (pairs, id) => {
  const counts = new Map(pairs);
  return [...counts.set(id, (counts.get(id) || 0) + 1)];
};

export function createPlaces({ scene }) {
  let heat = { cities: [], today: [], waves: [], min: 3 };
  let me = null;
  let city = null;
  let note = "";
  let knownToday = null;
  let echoes = [];
  let toastCity = null;
  let toastTimer = 0;

  const title = el("h3");
  const dot = el("span", { className: "dot" });
  const statusText = document.createTextNode("");
  const why = el("p", { className: "meta" });
  const buttons = el(
    "div",
    { className: "waves" },
    ...[...WAVES].map(([kind, emoji]) => {
      const button = el("button", { type: "button", className: "wave", title: kind, textContent: emoji });
      button.dataset.kind = kind;
      button.addEventListener("click", () => {
        button.animate([{ transform: "none" }, { transform: "translateY(-8px) scale(1.15)" }, { transform: "none" }], { duration: 450, easing: "steps(5)" });
        send(kind);
      });
      return button;
    }),
  );
  const count = el("p", { className: "meta" });
  const here = el("div", { className: "here" });
  const section = el("section", { className: "place" }, title, el("p", {}, dot, statusText), why, buttons, count, here);

  const nameOf = (id) => CITY_BY_ID.get(id)?.name || "";
  const fullName = (id) => {
    const c = CITY_BY_ID.get(id);
    return c ? `${c.name}, ${countryName(c.country)}` : "";
  };
  const online = (id) => new Map(heat.cities).get(id) || 0;
  const onMap = (id) => heat.today.includes(id);
  const wavesTo = (id) => new Map(heat.waves).get(id) || 0;

  function setHeat(next) {
    heat = next;
    announce(next.today);
    render();
  }

  function setMe(id) {
    me = id || null;
    render();
  }

  function open(id, meetups, openAll) {
    city = id;
    note = "";
    const link = (text, onclick) => el("button", { type: "button", className: "link", textContent: `${text} ›`, onclick });
    const links = meetups.slice(0, 2).map((m) => link(`meetup: ${m.label}`, m.open));
    if (meetups.length > 2) links.push(link(`+${meetups.length - 2} more meetups`, openAll));
    here.replaceChildren(...links);
    here.hidden = !meetups.length;
    for (const b of buttons.children) b.setAttribute("aria-label", `${b.dataset.kind} to ${nameOf(id)}`);
    render();
  }

  function close() {
    city = null;
  }

  function describe(id) {
    const n = online(id);
    if (n) return `${fullName(id)} · ${n} online`;
    if (onMap(id)) return `${fullName(id)} · today`;
    return id === me ? `${fullName(id)} · you` : fullName(id);
  }

  function render() {
    if (!city) return;
    const n = online(city);
    const lit = onMap(city);
    const waves = wavesTo(city);
    const you = city === me ? " · you" : "";
    title.textContent = fullName(city);
    dot.className = `dot ${n ? "live" : "quiet"}`;
    statusText.textContent = n ? `${n} online now${you}` : lit ? `on omarchy today${you}` : city === me ? "you" : "not on the map now";
    why.textContent = n ? "" : lit ? `Count shows at ${heat.min} online.` : city === me ? "On the map within the hour." : "";
    why.hidden = !why.textContent;
    buttons.hidden = !lit;
    count.textContent = note || (waves ? `${waves} ${waves === 1 ? "wave" : "waves"} today` : "");
    count.hidden = !lit || !count.textContent;
  }

  async function send(kind, to = city) {
    if (!to) return;
    scene.wave(to, kind);
    const echo = { key: `${to}:${kind}`, until: Date.now() + ECHO_MS };
    echoes.push(echo);
    let res = null;
    try {
      res = await fetch("api/wave", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ city: to, kind }) });
    } catch {}
    if (!res?.ok) echoes = echoes.filter((e) => e !== echo);
    note = res?.status === 429 ? "Too many waves, try in a minute." : res?.ok ? "" : "Wave failed.";
    render();
  }

  function received({ city: id, kind }) {
    heat = { ...heat, waves: bump(heat.waves, id) };
    const now = Date.now();
    echoes = echoes.filter((e) => e.until > now);
    const mine = echoes.findIndex((e) => e.key === `${id}:${kind}`);
    if (mine >= 0) echoes.splice(mine, 1);
    else if (!document.hidden) scene.wave(id, kind);
    if (id === city) render();
  }

  function announce(today) {
    const fresh = knownToday ? today.filter((id) => !knownToday.has(id)) : [];
    knownToday = new Set(today);
    if (!fresh.length) return;
    if (!document.hidden) for (const id of fresh) scene.pulse(id);
    [toastCity] = fresh;
    $("toast-text").textContent = fresh.length === 1 ? `${nameOf(toastCity)} lit up` : `${nameOf(toastCity)} and ${fresh.length - 1} more lit up`;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("toast").hidden = true), TOAST_MS);
  }

  $("toast-wave").addEventListener("click", () => {
    send("wave", toastCity);
    $("toast").hidden = true;
  });

  return { section, open, close, describe, setHeat, setMe, received };
}
