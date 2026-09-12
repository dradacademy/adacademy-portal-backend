const markModel = require("../models/markModel");

async function ensureMarkConfigExists() {
  try {
    await markModel.findByIdAndUpdate(
      "mark-based-on-levels",
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log("✅ Mark config ensured.");
  } catch (error) {
    console.error("❌ Error ensuring mark config:", error);
  }
}

const getMarkData = async (req, res) => {
  try {
    const markData = await markModel.findById("mark-based-on-levels");
    if (!markData) {
      return res.status(404).json({ error: "Mark configuration not found" });
    }
    return res.status(200).json(markData);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

const updateMarkData = async (req, res) => {
  try {
    const {
      level1Mark,
      level1NegativeMark,
      level2Mark,
      level2NegativeMark,
      level3Mark,
      level3NegativeMark,
      level4Mark,
      level4NegativeMark,
    } = req.body;

    const updatedData = await markModel.findByIdAndUpdate(
      "mark-based-on-levels",
      {
        ...(level1Mark !== undefined && { level1Mark }),
        ...(level1NegativeMark !== undefined && { level1NegativeMark }),
        ...(level2Mark !== undefined && { level2Mark }),
        ...(level2NegativeMark !== undefined && { level2NegativeMark }),
        ...(level3Mark !== undefined && { level3Mark }),
        ...(level3NegativeMark !== undefined && { level3NegativeMark }),
        ...(level4Mark !== undefined && { level4Mark }),
        ...(level4NegativeMark !== undefined && { level4NegativeMark }),
      },
      { new: true }
    );

    if (!updatedData) {
      return res.status(404).json({ error: "Mark configuration not found" });
    }

    return res.status(200).json(updatedData);
  } catch (error) {
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  ensureMarkConfigExists,
  getMarkData,
  updateMarkData,
};
