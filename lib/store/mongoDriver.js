// The production driver: a real MongoDB (Azure Cosmos DB for MongoDB, or any
// MongoDB-compatible server).
//
// It is deliberately thin. Every operation maps to one driver call, so there is
// almost nothing here that could behave differently from the database itself --
// the interesting decisions all live one level up in ../index.js.
//
// Cosmos DB's MongoDB API does not support every server feature (notably some
// aggregation stages and multi-document transactions), so nothing below uses
// them: the app's data access is single-collection reads, writes and counts,
// which Cosmos supports fully.

const { MongoClient } = require("mongodb");

/** `_id` is the integer id; the app says `id`. Translate at the boundary. */
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

function toStorageSort(sort) {
  if (!sort) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(sort)) out[k === "id" ? "_id" : k] = v;
  return out;
}

function toStorageProjection(projection) {
  if (!projection) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(projection)) out[k === "id" ? "_id" : k] = v;
  return out;
}

function create({ uri, dbName }) {
  let client = null;
  let db = null;

  async function connect() {
    client = new MongoClient(uri, {
      // A pilot App Service instance has no need for a large pool, and Cosmos
      // charges for idle connections.
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 15000,
      retryWrites: false, // Cosmos DB for MongoDB rejects retryWrites=true
    });
    await client.connect();
    db = client.db(dbName);
  }

  async function close() {
    if (client) await client.close();
    client = null;
    db = null;
  }

  async function ensureIndexes(indexes) {
    for (const [collection, specs] of Object.entries(indexes)) {
      for (const spec of specs) {
        try {
          await db.collection(collection).createIndex(spec);
        } catch (e) {
          // An index that can't be created is a performance problem, never a
          // correctness one -- a pilot must still start.
          console.error(`Could not create index on ${collection}:`, e.message);
        }
      }
    }
  }

  /**
   * Integer ids, allocated the way an AUTOINCREMENT column did.
   *
   * findOneAndUpdate with $inc is atomic on the server, so two requests
   * enrolling a respondent at the same moment cannot be handed the same id --
   * which a read-then-write would allow, and which would silently merge two
   * people's diaries.
   */
  async function nextId(collection) {
    const res = await db
      .collection("counters")
      .findOneAndUpdate(
        { _id: collection },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" }
      );
    const doc = res && res.value ? res.value : res;
    return doc.seq;
  }

  async function findOne(collection, filter = {}, options = {}) {
    const doc = await db.collection(collection).findOne(toStorageFilter(filter), {
      sort: toStorageSort(options.sort),
      projection: toStorageProjection(options.projection),
    });
    return toPublic(doc);
  }

  async function find(collection, filter = {}, options = {}) {
    let cursor = db.collection(collection).find(toStorageFilter(filter));
    if (options.projection) cursor = cursor.project(toStorageProjection(options.projection));
    if (options.sort) cursor = cursor.sort(toStorageSort(options.sort));
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    return (await cursor.toArray()).map(toPublic);
  }

  async function insert(collection, doc) {
    const id = doc.id != null ? doc.id : await nextId(collection);
    const { id: _ignored, ...rest } = doc;
    await db.collection(collection).insertOne({ _id: id, ...rest });
    // Keep the counter ahead of any explicitly-supplied id, so a seed that
    // writes fixed ids doesn't collide with the next allocated one.
    if (doc.id != null) {
      await db
        .collection("counters")
        .updateOne({ _id: collection, seq: { $lt: id } }, { $set: { seq: id } }, { upsert: false });
      await db.collection("counters").updateOne({ _id: collection }, { $setOnInsert: { seq: id } }, { upsert: true });
    }
    return { id };
  }

  async function update(collection, filter, patch) {
    // A bare object is a field update; an object of operators is passed
    // through, so callers can $inc or $unset when they need to.
    const hasOperators = Object.keys(patch).some((k) => k.startsWith("$"));
    const res = await db
      .collection(collection)
      .updateMany(toStorageFilter(filter), hasOperators ? patch : { $set: patch });
    return { changes: res.modifiedCount };
  }

  async function remove(collection, filter = {}) {
    const res = await db.collection(collection).deleteMany(toStorageFilter(filter));
    return { changes: res.deletedCount };
  }

  async function count(collection, filter = {}) {
    return db.collection(collection).countDocuments(toStorageFilter(filter));
  }

  async function distinct(collection, field, filter = {}) {
    return db.collection(collection).distinct(field === "id" ? "_id" : field, toStorageFilter(filter));
  }

  async function countBy(collection, field, filter = {}) {
    const rows = await db
      .collection(collection)
      .aggregate([{ $match: toStorageFilter(filter) }, { $group: { _id: `$${field}`, c: { $sum: 1 } } }])
      .toArray();
    const out = {};
    for (const r of rows) out[r._id] = r.c;
    return out;
  }

  return { connect, close, ensureIndexes, findOne, find, insert, update, remove, count, distinct, countBy };
}

module.exports = { create, toPublic };
