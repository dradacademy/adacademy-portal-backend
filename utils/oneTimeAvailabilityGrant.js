const recordedClassModel = require("../models/recordedClassModel");
const systemFlagModel = require("../models/systemFlagModel");
const { DAY_MS, endOfIstDay, getAvailableUntil } = require("./classAvailability");

const FLAG_ID = "recorded-classes-14-day-grant-2026-10";
const GRANT_DAYS = 14;

// One-time, requested by the admin (Oct 2026): every class already in the
// app — including ones whose window had already run out — becomes
// available to students for 14 days from the day this update goes live
// (until 11:59 PM IST on day 14).
//
// Rules:
//  - Only ACTIVE recordings (retired ones were hidden on purpose).
//  - Never shortens anything: a class set to "never expires", or already
//    available beyond the 14-day date, is left exactly as it is.
//  - Runs once ever: the SystemFlag row is created FIRST (unique _id), so
//    a second boot or a second server instance skips it. If the update
//    itself fails, the flag is removed so it is retried on the next boot.
const runOneTimeAvailabilityGrant = async () => {
  try {
    await systemFlagModel.create({ _id: FLAG_ID });
  } catch (error) {
    if (error && error.code === 11000) return; // already done
    console.error("14-day class grant: could not create marker:", error.message);
    return;
  }

  try {
    const target = endOfIstDay(Date.now() + GRANT_DAYS * DAY_MS);
    const recordings = await recordedClassModel.find({ active: true });

    const ops = [];
    for (const rec of recordings) {
      const currentUntil = getAvailableUntil(rec);
      if (currentUntil === null) continue; // never expires
      if (currentUntil.getTime() >= target.getTime()) continue; // already longer
      ops.push({
        updateOne: {
          filter: { _id: rec._id },
          update: { $set: { availableUntil: target } },
        },
      });
    }

    if (ops.length) await recordedClassModel.bulkWrite(ops);

    await systemFlagModel.updateOne(
      { _id: FLAG_ID },
      {
        $set: {
          details: {
            availableUntil: target,
            updated: ops.length,
            activeRecordings: recordings.length,
          },
        },
      }
    );
    console.log(
      `14-day class grant: ${ops.length} of ${recordings.length} active recordings now available until ${target.toISOString()}`
    );
  } catch (error) {
    console.error("14-day class grant failed, will retry next start:", error.message);
    await systemFlagModel.deleteOne({ _id: FLAG_ID }).catch(() => {});
  }
};

module.exports = { runOneTimeAvailabilityGrant };
