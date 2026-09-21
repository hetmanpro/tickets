#!/usr/bin/env node
/**
 * TicketSwap availability monitor for:
 * The National & Friends — Kursaal, San Sebastián — 18.10.2026
 *
 * What it does:
 *  - polls the event page every few seconds (randomized interval, looks like a normal visitor)
 *  - parses the "X Available • Y Sold • Z Wanted" text that's server-rendered in the HTML
 *  - the moment "Available" goes from 0 to something > 0:
 *      - fires a loud, repeating macOS notification + sound + spoken alert
 *      - opens the ticket page directly in your default browser
 *      - keeps re-alerting every few seconds until you touch the terminal (press Enter) or tickets are gone again
 *
 * It does NOT complete the purchase automatically — see chat for why (Stripe/3D-Secure,
 * and I could not test a real checkout flow while 0 tickets were listed). This gets you
 * from "I have no idea" to "browser is already open on the ticket, go click buy" in under
 * a second of detection latency.
 *
 * Run:   node monitor.js
 * Stop:  Ctrl+C
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const EVENT_URL =
  'https://www.ticketswap.com/concert-tickets/the-national-san-sebastian-kursaal-2026-10-18-CeFcVP2syv8RfL4po3RER';

// As of 2026-09-21 afternoon: regular Safari, regular Chrome AND Chrome incognito all got
// blocked ("Something went wrong" toast) — but Safari PRIVATE browsing and the TicketSwap
// phone app both stayed clean. That rules out an account-wide or pure-IP block (phone app
// is fine) and rules out a pure browser-engine fingerprint block (regular Safari is blocked
// while Safari private, same engine, isn't) — it looks like the specific sessions/cookies
// that got hammered with reloads today are what's flagged, not the browser or the account.
// Going conservative: slower pace, longer memory of a block, single browser for now.
// With 3 browsers rotating, each individual one only sees a request every ~3rd tick, so
// this can run a bit tighter than a single-browser pace would allow.
const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 25000;
const LOG_FILE = path.join(__dirname, 'monitor.log');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, 'browser-state.json');

// Twilio config lives only in config.json on this machine (copy config.example.json ->
// config.json and fill in your own values). If it's missing, phone calls are just skipped
// and you still get the local Mac alarm.
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
  // no config yet — that's fine, phone calls will be skipped
}
const twilioReady =
  config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber && config.twilioToNumber;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function randomInterval() {
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

function notify(title, message, { critical = false } = {}) {
  // macOS notification (visual)
  const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(
    /"/g,
    '\\"'
  )}" sound name "Sosumi"`;
  execFile('osascript', ['-e', script], () => {});
  if (critical) {
    process.stdout.write('\x07\x07\x07');
  }
}

// Loud alarm: push system volume to max and loop a siren-like sound several times in a row.
// A single soft "ding" won't wake anyone up — this is meant to be genuinely annoying.
const ALARM_SOUND = '/System/Library/Sounds/Sosumi.aiff';
let alarmRunning = false;

function ringAlarm(repeats = 8) {
  // save current volume so we can restore it afterwards, then max it out
  execFile('osascript', ['-e', 'set volume output volume 60']);
  if (alarmRunning) return; // don't stack multiple overlapping alarm loops
  alarmRunning = true;
  let count = 0;
  const playOnce = () => {
    if (count >= repeats) {
      alarmRunning = false;
      return;
    }
    count++;
    execFile('afplay', [ALARM_SOUND], () => {
      setTimeout(playOnce, 300);
    });
  };
  playOnce();
  // spoken alert in English, once per alarm burst — not the wake-up mechanism itself,
  // just extra context if you're within earshot
  execFile('say', ['-v', 'Samantha', 'Ticket alert. TicketSwap tickets are available now. Buy now.'], () => {});
}

// Real phone call via Twilio — this is what actually reaches you if you're asleep with the
// phone on silent. Uses a public Twilio "Twimlet" to read out a message, no server needed.
async function callPhone() {
  if (!twilioReady) {
    log('Twilio not configured (config.json missing/incomplete) — skipping phone call.');
    return;
  }
  const twimlUrl =
    'https://twimlets.com/message?Message%5B0%5D=' +
    encodeURIComponent('Ticket alert. TicketSwap tickets are available now. Go buy your ticket.');
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
  const body = new URLSearchParams({
    To: config.twilioToNumber,
    From: config.twilioFromNumber,
    Url: twimlUrl,
  });
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      log(`Twilio call failed: ${data.message || res.status}`);
    } else {
      log(`Twilio call placed: sid=${data.sid}`);
    }
  } catch (err) {
    log(`Twilio call error: ${err.message}`);
  }
}

// We drive two browsers, Safari and Chrome, and ALTERNATE between them on every check by
// default — this halves the request rate each individual browser sees, which is a much
// better defense against TicketSwap's per-browser rate limiting than only reacting after
// one is already blocked. On top of that, if a browser fails repeatedly, we put it in
// "cooldown" (skip it entirely) for a while and lean on the other one alone until then.
// Both need their own logged-in tab on the ticket page kept open at all times, and both
// need their "allow JavaScript from Apple Events" dev setting turned on (already done for
// both, from earlier).
// isSafari picks the AppleScript dialect: Safari has its own ("do JavaScript ... in tab",
// "current tab of w"); every Chromium-family browser (Chrome, Arc, and presumably
// Edge/Brave/etc if added later) shares Chrome's dialect ("execute ... javascript",
// "active tab index of w") — confirmed working on Arc 2026-09-21 via a manual
// `osascript -e 'tell application "Arc" to execute active tab of front window javascript "1+1"'` test.
const BROWSERS = {
  safari: { appName: 'Safari', isSafari: true },
  arc: { appName: 'Arc', isSafari: false },
  chrome: { appName: 'Google Chrome', isSafari: false },
};
// Which browsers actually get checked right now — edit this list to add/remove a browser
// from rotation without touching any other logic. Chrome is left out: as of 2026-09-21,
// regular Chrome AND Chrome incognito are both still blocked ("Something went wrong"),
// while Safari PRIVATE and fresh Arc are clean. Add 'chrome' back once you've confirmed
// (in the real browser, not just the log) that it works again.
// Arc taken back out (2026-09-21 20:48): its AppleScript "execute ... javascript" bridge
// appears to mangle the "|" separator character on the way back (the returned string looks
// right printed in a terminal but fails a literal split — likely a lookalike Unicode
// character swapped in by Arc's own scripting implementation). Not worth chasing further
// right now with two other browsers already working reliably. Re-add 'arc' here if you want
// to retry it later (e.g. after switching EXTRACT_JS to a delimiter-free, 3-separate-calls
// approach that doesn't depend on any specific character surviving the round trip).
const ACTIVE_BROWSERS = ['safari', 'arc', 'chrome']; // arc back in temporarily for diagnostics — checkAvailabilityOn now logs char codes on parse failure
let checkCount = 0;
const failCount = { safari: 0, arc: 0, chrome: 0 };
// Chrome (when active) fails fast and consistently once blocked — no point burning more
// checks confirming that. Safari almost never fails on its own. Arc is untested under real
// load, so give it a little slack like Safari rather than assuming it's as fragile as Chrome.
const SWITCH_AFTER_N_FAILURES = { safari: 3, arc: 3, chrome: 1 };
const COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes benched after a block — today's blocks are clearly outlasting the old 30 min guess
const cooldownUntil = { safari: 0, arc: 0, chrome: 0 };
// While benched, don't just wait out the full cooldown blind — send one "probe" check at it
// every PROBE_INTERVAL_MS. If the probe succeeds, it's unbenched immediately; if it fails,
// it stays benched and we just wait for the next probe (or the full cooldown to expire).
const PROBE_INTERVAL_MS = 20 * 60 * 1000;
const nextProbeAt = { safari: 0, arc: 0, chrome: 0 };
const probing = { safari: false, arc: false, chrome: false }; // true = this check IS the probe attempt

// Cooldown/probe state (which browser is benched and until when) is persisted to disk,
// because run.sh auto-restarts monitor.js after ANY crash — without this, a crash 2
// minutes into a 60-minute ban would wipe the ban and send that browser straight back at
// TicketSwap. Loaded once at startup, saved every time the state actually changes. Persists
// state for ALL known browsers (not just the active ones) so a benched-then-deactivated
// browser (like Chrome right now) keeps its cooldown if it's ever added back to rotation.
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const key of Object.keys(BROWSERS)) {
      if (saved.cooldownUntil && typeof saved.cooldownUntil[key] === 'number') cooldownUntil[key] = saved.cooldownUntil[key];
      if (saved.nextProbeAt && typeof saved.nextProbeAt[key] === 'number') nextProbeAt[key] = saved.nextProbeAt[key];
    }
    const now = Date.now();
    for (const key of Object.keys(BROWSERS)) {
      if (cooldownUntil[key] > now) {
        log(`Restored ${BROWSERS[key].appName} cooldown from disk — still benched for ${Math.round((cooldownUntil[key] - now) / 60000)} more min.`);
      } else if (cooldownUntil[key] !== 0) {
        // cooldown had already expired while we were down — clear it
        cooldownUntil[key] = 0;
        nextProbeAt[key] = 0;
      }
    }
  } catch (e) {
    // no saved state yet — fine, start clean
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ cooldownUntil, nextProbeAt }));
  } catch (e) {
    log(`Could not save browser-state.json: ${e.message}`);
  }
}

function benchBrowser(key) {
  cooldownUntil[key] = Date.now() + COOLDOWN_MS;
  nextProbeAt[key] = Date.now() + PROBE_INTERVAL_MS;
  saveState();
}

function unbenchBrowser(key) {
  cooldownUntil[key] = 0;
  nextProbeAt[key] = 0;
  failCount[key] = 0;
  saveState();
}

// Picks which browser to use for the next check: simple round-robin over ACTIVE_BROWSERS,
// skipping whichever one(s) are currently benched in cooldown — except for a probe check
// every PROBE_INTERVAL_MS to see if a benched browser has actually recovered. Returns null
// if every active browser is benched and none is due for a probe yet — sit that tick out.
function pickBrowserForNextCheck() {
  const now = Date.now();
  checkCount++;
  for (const key of Object.keys(probing)) probing[key] = false;
  if (ACTIVE_BROWSERS.length === 0) return null;
  const startIdx = checkCount % ACTIVE_BROWSERS.length;
  const ordered = ACTIVE_BROWSERS.slice(startIdx).concat(ACTIVE_BROWSERS.slice(0, startIdx));
  for (const key of ordered) {
    if (now >= cooldownUntil[key]) return key;
  }
  for (const key of ordered) {
    if (now >= nextProbeAt[key]) {
      probing[key] = true;
      nextProbeAt[key] = now + PROBE_INTERVAL_MS;
      return key;
    }
  }
  return null; // everyone's benched and no probe due yet
}

function focusTicketTab(browserKey) {
  const { appName, isSafari } = BROWSERS[browserKey];
  const script = isSafari
    ? `
    tell application "${appName}"
      activate
      repeat with w in windows
        set tabIndex to 0
        repeat with t in tabs of w
          set tabIndex to tabIndex + 1
          if (URL of t) contains "${EVENT_URL_MARKER}" then
            set current tab of w to t
            set index of w to 1
            return
          end if
        end repeat
      end repeat
    end tell
  `
    : `
    tell application "${appName}"
      activate
      repeat with w in windows
        set tabIndex to 0
        repeat with t in tabs of w
          set tabIndex to tabIndex + 1
          if (URL of t) contains "${EVENT_URL_MARKER}" then
            set active tab index of w to tabIndex
            set index of w to 1
            return
          end if
        end repeat
      end repeat
    end tell
  `;
  execFile('osascript', ['-e', script], () => {});
}

// A plain Node `fetch` gets a 403 from TicketSwap — their anti-bot layer checks the browser's
// TLS/JS fingerprint, which Node can't fake. So instead we ask your actual, already-open,
// already-logged-in browser to do the request for us (via AppleScript "execute/do JavaScript
// in tab"). Same-origin request from the real browser sails through.
//
// One-time setup needed in BOTH browsers: Chrome → View → Developer → "Allow JavaScript from
// Apple Events"; Safari → Settings → Advanced → "Show features for web developers", then
// Develop menu → "Allow JavaScript from Apple Events". First run of each triggers a macOS
// permission popup to let Terminal/Node control it — click OK.

const EVENT_URL_MARKER = 'CeFcVP2syv8RfL4po3RER'; // unique bit of the event URL, used to find the right tab

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// Pulls out the number immediately before a given word (e.g. "3" before "available") by
// scanning backward over whitespace then digits — no regex (AppleScript string-escaping
// of backslashes is a minefield, see earlier bugs). Case-insensitive on a lowercased copy
// of the text so it doesn't matter whether the raw markup says "Available"/"available"/
// "AVAILABLE" — toLowerCase() doesn't change string length for ASCII, so positions still
// line up with the original (correctly-cased, untouched-by-CSS) text for digit-scanning.
// We now pull "available", "sold" AND "wanted" every check — not just to catch a page
// layout change, but as a sanity signal: if TicketSwap ever serves us a frozen/cached
// snapshot instead of a real block (to quietly shadow-ban a detected bot rather than show
// an obvious 403), "sold"/"wanted" would very likely also stop moving. If they carry on
// changing over time while "available" stays put, that's reassuring; if ALL three counters
// go dead for hours, that's a real reason to suspect we're being served stale data.
const EXTRACT_JS =
  // Tried a control-character separator here briefly (2026-09-21) to dodge a rare dropped-
  // pipe glitch, but Arc turned out to JSON-escape control characters into literal "\u0001"
  // text on every single call — a systematic break, worse than the original occasional
  // glitch. Back to the plain "|||" separator, which only failed once in many calls and
  // self-recovered (checkAvailability already retries/logs on any parse failure — harmless).
  "(function(){try{if(!document.body){return 'NOMATCH|||len=0';}var tRaw=document.body.textContent;var tLower=tRaw.toLowerCase();var isSpace=function(c){var code=c.charCodeAt(0);return code===32||code===160||code===10||code===9||code===13;};var findNum=function(label){var i=tLower.indexOf(label);if(i===-1)return '';var k=i-1;while(k>=0&&isSpace(tRaw[k]))k--;var end=k+1;while(k>=0&&tRaw[k]>='0'&&tRaw[k]<='9')k--;var start=k+1;return tRaw.slice(start,end);};var avail=findNum('available');if(!avail){return 'NOMATCH|||len='+tRaw.length;}var sold=findNum('sold');var wanted=findNum('wanted');return 'MATCH|||'+avail+'|||'+sold+'|||'+wanted;}catch(e){return 'JSERR|||'+e.message;}})()";

async function checkAvailabilityOn(browserKey) {
  const { appName, isSafari } = BROWSERS[browserKey];
  const reloadCmd = isSafari
    ? `do JavaScript "location.reload();" in targetTab`
    : `execute targetTab javascript "location.reload();"`;
  const runJs = (varName) =>
    isSafari ? `set ${varName} to (do JavaScript jsCode in targetTab)` : `set ${varName} to execute targetTab javascript jsCode`;
  const readyWait = isSafari
    ? `
      set waited to 0
      repeat
        set rs to "loading"
        try
          set rs to (do JavaScript "document.readyState" in targetTab)
        end try
        if rs is "complete" then exit repeat
        if waited > 15 then exit repeat
        delay 0.3
        set waited to waited + 0.3
      end repeat`
    : `
      set waited to 0
      repeat while (loading of targetTab) and waited < 15
        delay 0.3
        set waited to waited + 0.3
      end repeat`;
  const script = `
    set frontApp to ""
    try
      tell application "System Events" to set frontApp to name of first application process whose frontmost is true
    end try
    set finalResult to ""
    tell application "${appName}"
      set targetTab to missing value
      repeat with w in windows
        repeat with t in tabs of w
          if (URL of t) contains "${EVENT_URL_MARKER}" then
            set targetTab to t
            exit repeat
          end if
        end repeat
        if targetTab is not missing value then exit repeat
      end repeat
      if targetTab is missing value then
        error "NOTABFOUND: open the ticket page tab yourself in your logged-in ${appName} window, then restart monitor.js"
      end if
      -- TicketSwap's gateway blocks silent background fetch/XHR requests (403), but a real
      -- page load (same as pressing reload) goes through fine. So we reload the tab via an
      -- in-page JS reload rather than AppleScript's "set URL of tab" (which yanks the window
      -- to the front).
      ${reloadCmd}
      delay 0.6
      ${readyWait}
      delay 0.5
      set jsCode to "${EXTRACT_JS}"
      ${runJs('jsResult')}
      -- If the page body is still empty (reload hadn't really finished), give it a couple
      -- more short retries before giving up on this check cycle.
      set retryCount to 0
      repeat while (jsResult contains "len=0") and retryCount < 4
        delay 0.7
        ${runJs('jsResult')}
        set retryCount to retryCount + 1
      end repeat
      set finalResult to jsResult
    end tell
    if frontApp is not "" and frontApp is not "${appName}" then
      try
        tell application frontApp to activate
      end try
    end if
    return finalResult
  `;
  const raw = await runAppleScript(script);
  let trimmed = raw.trim();
  // Root cause found 2026-09-21 via a char-code dump: Arc's "execute ... javascript" wraps
  // a returned STRING in literal double quotes (JSON.stringify-style) — "MATCH|||0|||6|||438"
  // — while Chrome/Safari return the bare string. That leading quote broke every single
  // marker check ('"MATCH' !== 'MATCH'), which looked like "random corruption" in the log
  // but was actually 100% consistent for Arc. Strip a wrapping pair of double quotes if
  // present before parsing — harmless no-op for Chrome/Safari, which never have them.
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    trimmed = trimmed.slice(1, -1);
  }
  const parts = trimmed.split('|||');
  const marker = parts[0];
  if (marker === 'JSERR') {
    throw new Error(`${appName} JS error: ${parts[1]}`);
  }
  if (marker === 'NOMATCH') {
    throw new Error(`Could not find the "Available" counter in the page via ${appName} (${parts.slice(1).join(', ')}) — TicketSwap may have changed their page layout, or the tab did not load in time.`);
  }
  // marker === 'MATCH' isn't enough on its own — a corrupted separator (seen intermittently
  // on Arc, character-for-character identical to "|||" when printed but apparently not
  // matching a literal split) can still leave parts[0] as exactly "MATCH" while parts[1]/[2]/
  // [3] are scrambled together. Insist on exactly 4 parts too, or treat it as a parse failure
  // rather than silently returning wrong numbers.
  if (marker !== 'MATCH' || parts.length !== 4) {
    const codes = Array.from(trimmed.slice(0, 60)).map((c) => c.charCodeAt(0)).join(',');
    throw new Error(`Unexpected AppleScript/${appName} output: ${JSON.stringify(trimmed.slice(0, 200))} (parts=${parts.length}, first 60 char codes: ${codes})`);
  }
  return {
    available: parseInt(parts[1], 10),
    sold: parts[2] !== undefined && parts[2] !== '' ? parseInt(parts[2], 10) : null,
    wanted: parts[3] !== undefined && parts[3] !== '' ? parseInt(parts[3], 10) : null,
  };
}

let lastCheckedBrowserKey = 'safari'; // which browser tab actually showed the last result — used to focus the right one on a hit

async function checkAvailability() {
  const browserKey = pickBrowserForNextCheck();
  if (browserKey === null) {
    return null; // benched with no fallback, not probe time yet — sit this tick out quietly
  }
  const wasProbe = probing[browserKey];
  lastCheckedBrowserKey = browserKey;
  try {
    const result = await checkAvailabilityOn(browserKey);
    failCount[browserKey] = 0;
    if (wasProbe) {
      unbenchBrowser(browserKey);
      log(`Probe check on ${BROWSERS[browserKey].appName} succeeded — unbenching it early.`);
      notify('✅ TicketSwap-монітор', `${BROWSERS[browserKey].appName} знову працює — повернув у чергу.`);
    }
    return result;
  } catch (err) {
    if (wasProbe) {
      log(`Probe check on ${BROWSERS[browserKey].appName} still failing — staying benched, next probe in ${PROBE_INTERVAL_MS / 60000} min.`);
      throw err;
    }
    failCount[browserKey]++;
    if (failCount[browserKey] >= SWITCH_AFTER_N_FAILURES[browserKey]) {
      benchBrowser(browserKey);
      const others = ACTIVE_BROWSERS.filter((k) => k !== browserKey).map((k) => BROWSERS[k].appName).join(', ') || 'нікого — усі активні браузери в бані';
      log(`${BROWSERS[browserKey].appName} failed ${failCount[browserKey]} times in a row — benching it for ${COOLDOWN_MS / 60000} min (probing every ${PROBE_INTERVAL_MS / 60000} min), leaning on ${others}.`);
      notify('🔀 TicketSwap-монітор', `${BROWSERS[browserKey].appName} не відповідає — тимчасово перейшов на ${others}`);
      failCount[browserKey] = 0;
    }
    throw err;
  }
}

let lastAvailable = 0;
let consecutiveErrors = 0;
let alertInterval = null;

function startAlertLoop() {
  if (alertInterval) return;
  notify('🎟️ TicketSwap: квитки з’явились!', 'The National, San Sebastián — відкриваю сторінку!', {
    critical: true,
  });
  focusTicketTab(lastCheckedBrowserKey);
  ringAlarm(10);
  callPhone();
  // repeat: local alarm every 8s, a fresh phone call every 45s (so it keeps ringing
  // until you actually pick up / it's gone, but doesn't spam a call every few seconds)
  let ticksSinceLastCall = 0;
  alertInterval = setInterval(() => {
    notify('🎟️ Квитки ще є (або щойно були) — перевір!', EVENT_URL, { critical: true });
    ringAlarm(10);
    ticksSinceLastCall++;
    if (ticksSinceLastCall * 8 >= 45) {
      callPhone();
      ticksSinceLastCall = 0;
    }
  }, 8000);
}

function stopAlertLoop() {
  if (alertInterval) {
    clearInterval(alertInterval);
    alertInterval = null;
  }
}

let lastSold = null;
let lastWanted = null;
let soldWantedUnchangedSince = null; // timestamp since sold+wanted last moved at all
let staleWarningFired = false;
const STALE_WARNING_MS = 60 * 60 * 1000; // if sold+wanted never budge for an hour straight,
// that's a real hint TicketSwap might be quietly serving us a frozen/cached page instead of
// live data (a "shadow ban" — no obvious block, just stale content) rather than actually
// having zero activity on a 438-wanted show for an hour.

async function tick() {
  try {
    const checkResult = await checkAvailability();
    if (checkResult === null) {
      // benched with nothing to fall back to — skip quietly, no error, no noise
      setTimeout(tick, randomInterval());
      return;
    }
    const { available, sold, wanted } = checkResult;
    consecutiveErrors = 0;
    const via = `[${BROWSERS[lastCheckedBrowserKey].appName}]`;
    if (available !== lastAvailable) {
      log(`${via} Available changed: ${lastAvailable} -> ${available}`);
    } else {
      log(`${via} available=${available} sold=${sold ?? '?'} wanted=${wanted ?? '?'}`);
    }

    if (sold !== null && wanted !== null) {
      if (sold !== lastSold || wanted !== lastWanted) {
        soldWantedUnchangedSince = Date.now();
        staleWarningFired = false;
      } else if (soldWantedUnchangedSince === null) {
        soldWantedUnchangedSince = Date.now();
      } else if (!staleWarningFired && Date.now() - soldWantedUnchangedSince >= STALE_WARNING_MS) {
        staleWarningFired = true;
        log(`⚠️ "sold"/"wanted" counters haven't moved in ${STALE_WARNING_MS / 60000} min (sold=${sold}, wanted=${wanted}) — might be a sign TicketSwap is serving a stale/cached page instead of a real block. Worth eyeballing the page yourself.`);
        notify('⚠️ TicketSwap-монітор', 'Лічильники не рухаються вже годину — можливо, віддають застарілу сторінку. Перевір вручну.');
      }
      lastSold = sold;
      lastWanted = wanted;
    }

    if (available > 0) {
      startAlertLoop();
    } else {
      stopAlertLoop();
    }
    lastAvailable = available;
  } catch (err) {
    consecutiveErrors++;
    log(`ERROR: ${err.message} (consecutive: ${consecutiveErrors})`);
    if (consecutiveErrors >= 5) {
      notify('⚠️ TicketSwap-монітор', 'Кілька помилок поспіль — перевір, чи все ще працює скрипт.');
    }
  } finally {
    setTimeout(tick, randomInterval());
  }
}

log('=== TicketSwap monitor started ===');
log(`Watching: ${EVENT_URL}`);
loadState();
notify('TicketSwap-монітор запущено', 'Слідкую за квитками на The National (Сан-Себастьян).');

if (process.argv.includes('--test')) {
  log('--test flag: simulating a ticket becoming available (siren + call), not touching real availability tracking.');
  startAlertLoop();
  setTimeout(stopAlertLoop, 20000); // stop the test alarm after 20s so it doesn't run forever
}

tick();
