"use strict";

const { MongoClient } = require("mongodb");
const env = require("./env");

let client;
let db;
let connecting;

const COLLECTIONS = {
  users: "users",
  attendance: "attendance",
  leaves: "leaves",
  offices: "offices",
  shifts: "shifts",
  holidays: "holidays",
  settings: "settings",
  auditLogs: "auditLogs",
};

/**
 * Connect once and reuse.
 *
 * The in-flight promise is memoised, not just the result: on a serverless
 * platform several requests can hit a cold instance at once, and without this
 * each would open its own client and leak connections until Atlas refuses new
 * ones. A small pool suits serverless, where many instances each hold one.
 */
async function connect(uri = env.mongoUri, dbName = env.dbName) {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    const created = new MongoClient(uri, {
      maxPoolSize: env.isServerless ? 5 : 10,
      serverSelectionTimeoutMS: 10000,
    });
    await created.connect();
    client = created;
    db = created.db(dbName);
    await ensureIndexes(db);
    return db;
  })();

  try {
    return await connecting;
  } catch (err) {
    // Let the next request try again rather than caching the failure forever.
    connecting = undefined;
    throw err;
  }
}

function getDb() {
  if (!db) throw new Error("Database not connected. Call connect() first.");
  return db;
}

const collection = (name) => getDb().collection(name);

async function ensureIndexes(database) {
  await Promise.all([
    database.collection(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true }),
    database.collection(COLLECTIONS.users).createIndex({ employeeCode: 1 }, { unique: true, sparse: true }),
    database.collection(COLLECTIONS.users).createIndex({ department: 1, status: 1 }),
    // One attendance row per person per shift-day: this unique index is what
    // stops a double-tap on Check In from creating two records.
    database.collection(COLLECTIONS.attendance).createIndex({ userId: 1, date: 1 }, { unique: true }),
    database.collection(COLLECTIONS.attendance).createIndex({ date: 1, status: 1 }),
    database.collection(COLLECTIONS.leaves).createIndex({ userId: 1, fromDate: 1 }),
    database.collection(COLLECTIONS.leaves).createIndex({ status: 1, fromDate: 1 }),
    database.collection(COLLECTIONS.holidays).createIndex({ date: 1 }, { unique: true }),
    database.collection(COLLECTIONS.auditLogs).createIndex({ at: -1 }),
    database.collection(COLLECTIONS.auditLogs).createIndex({ targetType: 1, targetId: 1 }),
  ]);
}

/**
 * Inject a database instance for tests. The sandbox has no mongod binary, so
 * the service tests run against an in-memory stand-in (see
 * tests/helpers/memory-mongo.js) wired in through here.
 */
function __setDbForTests(instance) {
  db = instance;
}

async function close() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
  connecting = undefined;
}

module.exports = { connect, getDb, close, collection, COLLECTIONS, ensureIndexes, __setDbForTests };
