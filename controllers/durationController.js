const durationModel = require("../models/durationModel");

async function ensureDurationConfigExists() {
  try {
    await durationModel.findByIdAndUpdate(
      "duration-in-seconds",
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log("✅ Duration config ensured.");
  } catch (error) {
    console.error("❌ Error ensuring duration config:", error);
  }
}

const getDurationData = async (req, res) => {
  try {
    const durationData = await durationModel.findById("duration-in-seconds");
    if (!durationData) {
      return res
        .status(404)
        .json({ error: "Duration configuration not found" });
    }
    return res.status(200).json(durationData);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

const updateDurationData = async (req, res) => {
  try {
    const { level1Duration, level2Duration, level3Duration, level4Duration } =
      req.body;

    const updatedData = await durationModel.findByIdAndUpdate(
      "duration-in-seconds",
      {
        ...(level1Duration !== undefined && { level1Duration }),
        ...(level2Duration !== undefined && { level2Duration }),
        ...(level3Duration !== undefined && { level3Duration }),
        ...(level4Duration !== undefined && { level4Duration }),
      },
      { new: true }
    );

    if (!updatedData) {
      return res
        .status(404)
        .json({ error: "Duration configuration not found" });
    }

    return res.status(200).json(updatedData);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  ensureDurationConfigExists,
  getDurationData,
  updateDurationData,
};
