// The local driver: MongoDB query semantics, in this process, backed by a
// JSON file.
//
// It exists so the app can be run and fully tested without a MongoDB server --
// during development, in CI, and anywhere the real database isn't reachable.
// Filtering and updating are done by `mingo`, which implements MongoDB's own
// query and update operators, so a filter that works here works against the
// real server rather than merely appearing to.
//
// Writes are serialised across processes with a lock file, so the app server
// and a test harness can safely share one database file.
//
// It is still NOT a production store: the whole database is held in memory and
// rewritten as one file on every write, which does not survive a second App
// Service instance and does not scale past a demo. Production sets MONGODB_URI
// and gets ../mongoDriver.js instead.

const fs = require("fs");
const path = require("path");
const mingo = require("mingo");

function toPublic(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function toStorageFilter(filter = {}) {
  if (!filter || typeof filter !== "object") return filter;
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === "id") out._id = v;
    else if (k === "$or" || k === "$and" || k === "$nor") out[k] = v.map(toStorageFilter);
    else out[k] = v;
  }
  return out;
}

function storageKey(k) {
  return k === "id" ? "_id" : k;
}

function compare(a, b) {
  if (a === b) return 0;
  // Mongo sorts missing/null before everything else; matching that keeps the
  // ordering of a list with blank fields the same on both drivers.
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

function sortDocs(docs, sort) {
  const keys = Object.entries(sort).map(([k, dir]) => [storageKey(k), dir < 0 ? -1 : 1]);
  return docs.slice().sort((x, y) => {
    for (const [k, dir] of keys) {
      const r = compare(x[k], y[k]);
      if (r !== 0) return r * dir;
    }
    return 0;
  });
}

function project(doc, projection) {
  if (!projection) return doc;
  const keys = Object.entries(projection);
  const including = keys.some(([, v]) => v);
  const out = including ? {} : { ...doc };
  for (const [k, v] of keys) {
    const key = storageKey(k);
    if (v) out[key] = doc[key];
    else delete out[key];
  }
  if (including && doc._id !== undefined && projection.id !== 0 && projection._id !== 0) out._id = doc._id;
  return out;
}

function create({ file }) {
  let data = {};
  let counters = {};
  // The file's state as we last saw it. Another process (the test harness, a
  // seed run) can write between our operations, and a cached copy would then
  // be answering from a database that no longer exists -- so every operation
  // checks first and reloads if the file moved underneath us. One stat call is
  // cheap; silently serving stale rows is not.
  let seen = { mtimeMs: 0, size: -1 };

  function stampFrom(stat) {
    seen = { mtimeMs: stat.mtimeMs, size: stat.size };
  }

  function load() {
    if (!file || !fs.existsSync(file)) {
      data = {};
      counters = {};
      seen = { mtimeMs: 0, size: -1 };
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      data = parsed.collections || {};
      counters = parsed.counters || {};
      stampFrom(fs.statSync(file));
    } catch (e) {
      throw new Error(`The local database file at ${file} could not be read: ${e.message}`);
    }
  }

  function refreshIfChanged() {
    if (!file) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      if (seen.size !== -1) load(); // the file was removed underneath us
      return;
    }
    if (stat.mtimeMs !== seen.mtimeMs || stat.size !== seen.size) load();
  }

  // A write is read-modify-write over the whole file, so two processes writing
  // at the same moment would lose one of the writes -- and with the app server
  // and a test harness both connected, that happens often enough to make a
  // test suite flaky for reasons that have nothing to do with the code under
  // test. An exclusive lock file makes each write atomic across processes.
  //
  // `wx` fails if the file already exists, which is the atomic
  // test-and-set this needs. A stale lock (a process killed mid-write) is
  // broken after a timeout rather than deadlocking every later run.
  const lockPath = file ? `${file}.lock` : null;
  const LOCK_STALE_MS = 5000;

  async function withLock(fn) {
    if (!lockPath) return fn();
    const started = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const fd = fs.openSync(lockPath, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let age = 0;
        try {
          age = Date.now() - fs.statSync(lockPath).mtimeMs;
        } catch (_) {
          continue; // the holder released it between our check and our stat
        }
        if (age > LOCK_STALE_MS) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_) {
            /* someone else cleared it first */
          }
          continue;
        }
        if (Date.now() - started > LOCK_STALE_MS * 2) {
          throw new Error(`Timed out waiting for the local database lock at ${lockPath}`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    try {
      // Whoever held the lock may have written; start from what is on disk.
      refreshIfChanged();
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {
        /* already gone */
      }
    }
  }

  // Written whole and immediately -- not deferred -- so another process
  // reading the file next sees this write. Temp file then rename, so a crash
  // mid-write can't leave a truncated database behind.
  function persist() {
    if (!file) return;
    const tmp = `${file}.tmp.${process.pid}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ collections: data, counters }));
    fs.renameSync(tmp, file);
    stampFrom(fs.statSync(file));
  }

  function coll(name) {
    if (!data[name]) data[name] = [];
    return data[name];
  }

  function matching(name, filter) {
    const q = new mingo.Query(toStorageFilter(filter || {}));
    return coll(name).filter((d) => q.test(d));
  }

  async function connect() {
    load();
  }

  async function close() {
    // Nothing to flush: every write persists before it returns. Writing again
    // here without the lock could clobber another process's newer write.
  }

  async function ensureIndexes() {
    // No indexes to build: everything is an in-memory scan.
  }

  function nextId(name) {
    counters[name] = (counters[name] || 0) + 1;
    return counters[name];
  }

  async function findOne(name, filter = {}, options = {}) {
    refreshIfChanged();
    let docs = matching(name, filter);
    if (options.sort) docs = sortDocs(docs, options.sort);
    const doc = docs[0];
    return doc ? toPublic(project({ ...doc }, options.projection)) : undefined;
  }

  async function find(name, filter = {}, options = {}) {
    refreshIfChanged();
    let docs = matching(name, filter);
    if (options.sort) docs = sortDocs(docs, options.sort);
    if (options.skip) docs = docs.slice(options.skip);
    if (options.limit) docs = docs.slice(0, options.limit);
    return docs.map((d) => toPublic(project({ ...d }, options.projection)));
  }

  async function insert(name, doc) {
    return withLock(async () => {
      const id = doc.id != null ? doc.id : nextId(name);
      const { id: _ignored, ...rest } = doc;
      coll(name).push({ _id: id, ...rest });
      if (doc.id != null && (counters[name] || 0) < id) counters[name] = id;
      persist();
      return { id };
    });
  }

  async function update(name, filter, patch) {
    return withLock(async () => {
      const hasOperators = Object.keys(patch).some((k) => k.startsWith("$"));
      const spec = hasOperators ? patch : { $set: patch };
      const docs = matching(name, filter);
      let changes = 0;
      for (const doc of docs) {
        const before = JSON.stringify(doc);
        mingo.update(doc, spec);
        if (JSON.stringify(doc) !== before) changes++;
      }
      if (changes) persist();
      return { changes };
    });
  }

  async function remove(name, filter = {}) {
    return withLock(async () => {
      const q = new mingo.Query(toStorageFilter(filter || {}));
      const before = coll(name).length;
      data[name] = coll(name).filter((d) => !q.test(d));
      const changes = before - data[name].length;
      if (changes) persist();
      return { changes };
    });
  }

  async function count(name, filter = {}) {
    refreshIfChanged();
    return matching(name, filter).length;
  }

  async function distinct(name, field, filter = {}) {
    refreshIfChanged();
    const key = storageKey(field);
    return [...new Set(matching(name, filter).map((d) => d[key]))];
  }

  async function countBy(name, field, filter = {}) {
    refreshIfChanged();
    const key = storageKey(field);
    const out = {};
    for (const d of matching(name, filter)) {
      const v = d[key];
      out[v] = (out[v] || 0) + 1;
    }
    return out;
  }

  return { connect, close, ensureIndexes, findOne, find, insert, update, remove, count, distinct, countBy };
}

module.exports = { create };
