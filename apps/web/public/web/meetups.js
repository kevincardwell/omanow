// Meetup card + list for the web host. Data comes from /api/meetups (the
// omarchy.org listing). Everything from it is rendered as text only.

const $ = (id) => document.getElementById(id);

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};

const isUpcoming = (m, now = Date.now()) => Date.parse(m.end || m.start) >= now;

// Shown in the event's own timezone, which is what the organizers announce.
function formatWhen(m) {
  const opts = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  const start = new Date(m.start);
  try {
    return start.toLocaleString(undefined, { ...opts, timeZone: m.timezone || undefined });
  } catch {
    return start.toLocaleString(undefined, opts);
  }
}

function formatDay(m) {
  const start = new Date(m.start);
  try {
    return start.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: m.timezone || undefined });
  } catch {
    return start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

function relative(m, now = Date.now()) {
  const start = Date.parse(m.start);
  const end = Date.parse(m.end || m.start);
  if (start <= now && now <= end) return "happening now";
  const days = Math.round((start - now) / 86400e3);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(days) < 1) return rtf.format(Math.round((start - now) / 3600e3), "hour");
  return rtf.format(days, "day");
}

const regions = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();

const countryName = (code) => {
  try {
    return (code && regions?.of(code)) || code;
  } catch {
    return code;
  }
};

function place(m) {
  if (m.near) return `${m.online ? "online" : "address shared with guests"} · shown near ${m.near} (event timezone)`;
  const where = [m.city, countryName(m.country)].filter(Boolean).join(", ");
  if (m.approximate) return `${where ? `around ${where}` : "approximate place"} · exact place shared with guests`;
  return m.online ? [where, "online"].filter(Boolean).join(" · ") : where;
}

const safeUrl = (u, host) => {
  try {
    const url = new URL(u);
    const hostOk = !host || url.hostname === host || url.hostname.endsWith(`.${host}`);
    return url.protocol === "https:" && hostOk ? url : null;
  } catch {
    return null;
  }
};

export function createMeetupsUi({ onFocus, onFly }) {
  let list = [];
  let byId = new Map();
  const card = $("meetup-card");
  const body = $("meetup-card-body");
  const dialog = $("meetups-list");

  function set(meetups) {
    list = meetups.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
    byId = new Map(list.map((m) => [m.id, m]));
    const upcoming = list.filter((m) => isUpcoming(m)).length;
    $("meetups-open").textContent = `[ meetups · ${upcoming} upcoming ]`;
    $("meetups-open").hidden = list.length === 0;
  }

  function markers() {
    return list.map((m) => ({ id: m.id, lat: m.lat, lon: m.lon, upcoming: isUpcoming(m), label: m.city || "" }));
  }

  function renderEvent(m) {
    const upcoming = isUpcoming(m);
    const cover = safeUrl(m.cover, "omarchy.org");
    const link = safeUrl(m.url);
    const linkSite = link && (link.hostname === "luma.com" ? "Luma" : link.hostname.split(".").at(-2));
    return el(
      "article",
      { className: `event${upcoming ? "" : " past"}` },
      cover && el("img", { src: cover.href, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }),
      el("p", { className: "when" }, el("span", { className: "tag", textContent: upcoming ? relative(m) : "happened" }), " ", formatWhen(m)),
      el("h3", { textContent: m.name }),
      el("p", { className: "where", textContent: place(m) }),
      m.hosts?.length > 0 && el("p", { className: "meta", textContent: `hosted by ${m.hosts.join(", ")}` }),
      link &&
        el("a", {
          className: "btn primary",
          href: link.href,
          target: "_blank",
          rel: "noopener noreferrer",
          textContent: `[ open on ${linkSite} ↗ ]`,
        }),
    );
  }

  function select(ids) {
    const events = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!events.length) {
      card.hidden = true;
      onFocus([]);
      return;
    }
    body.replaceChildren(...events.map(renderEvent));
    card.hidden = false;
    card.scrollTop = 0;
    onFocus(events.map((m) => m.id));
  }

  function renderList() {
    const now = Date.now();
    const upcoming = list.filter((m) => isUpcoming(m, now));
    const past = list.filter((m) => !isUpcoming(m, now)).reverse();
    const item = (m) =>
      el(
        "li",
        {},
        el(
          "button",
          {
            type: "button",
            onclick: () => {
              dialog.close();
              onFly(m);
              select([m.id]);
            },
          },
          el("span", { className: "date", textContent: formatDay(m) }),
          el("span", { className: "name", textContent: m.name }),
          el("span", { className: "city", textContent: m.city || m.near || "" }),
        ),
      );
    $("meetups-body").replaceChildren(
      el("h3", { textContent: `upcoming · ${upcoming.length}` }),
      el("ul", {}, ...upcoming.map(item)),
      past.length && el("details", {}, el("summary", { textContent: `already happened · ${past.length}` }), el("ul", {}, ...past.map(item))),
    );
  }

  $("meetup-card-close").addEventListener("click", () => select([]));
  $("meetups-open").addEventListener("click", () => {
    renderList();
    dialog.showModal();
  });
  $("meetups-close").addEventListener("click", () => dialog.close());

  return { set, markers, select, byId: (id) => byId.get(id) };
}
