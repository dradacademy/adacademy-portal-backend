const contentItemModel = require("../models/contentItemModel");

const VALID_TYPES = ["achiever", "testimonial", "gallery", "announcement"];

// The exact real content that was hardcoded into the homepage components
// during the Phase 1 front-page rebuild. seedDefaults() below only ever
// inserts a type's defaults if that type currently has zero items in the
// database — so this is always safe to run again later (e.g. after the
// admin has deleted everything of one type on purpose, running seed again
// would restore these — that's an accepted tradeoff of keeping this
// idempotent-by-emptiness rather than tracking "has this ever run").
const DEFAULT_CONTENT = {
  achiever: [
    {
      title: "Priya Darsini A",
      subtitle: "Civil Engineering",
      body: "Received an NIT offer in the first round of CCMT 2026 counselling.",
      image: "/achievers/priya-darsini-a.png",
      badge: "GATE Qualified",
      meta: "GATE 2026",
      order: 1,
    },
    {
      title: "Shri Hari Varsha S",
      subtitle: "Civil Engineering",
      body: "Received an NIT offer in the first round of CCMT 2026 counselling.",
      image: "/achievers/shri-hari-varsha-s.png",
      badge: "GATE Qualified",
      meta: "GATE 2026",
      order: 2,
    },
  ],
  testimonial: [
    {
      title: "Shri Hari Varsha S",
      subtitle: "GATE 2026, Civil Engineering",
      body: "The structured revision cycles made formula mastery feel natural instead of rushed.",
      order: 1,
    },
    {
      title: "Priya Darsini A",
      subtitle: "GATE 2026, Civil Engineering",
      body: "Every mock became a clear conversation with my preparation. I knew exactly what to fix next.",
      order: 2,
    },
  ],
  gallery: [
    {
      title: "Reception / Entrance",
      subtitle: "Facility",
      image: "/gallery/reception-entrance.png",
      order: 1,
    },
    {
      title: "Classroom",
      subtitle: "Facility",
      image: "/gallery/classroom.png",
      order: 2,
    },
    {
      title: "Meeting Room",
      subtitle: "Facility",
      image: "/gallery/meeting-room.png",
      order: 3,
    },
    {
      title: "Faculty Room",
      subtitle: "Facility",
      image: "/gallery/faculty-room.png",
      order: 4,
    },
    {
      title: "Digital Classroom",
      subtitle: "Facility",
      image: "/gallery/digital-classroom.png",
      order: 5,
    },
  ],
  announcement: [
    {
      title: "GATE 2027 (Civil Engineering) — Batch 2 Enrollment Open",
      subtitle: "Admissions close Sept 15, 2026",
      body: "Hybrid mode (Online & Offline), 6:00 PM – 8:30 PM. Batch strength 60 — limited seats left. Special offer for 3rd-year Civil Engineering students to build their GATE foundation early. Batch commences September 16, 2026.",
      ctaLabel: "Call / WhatsApp +91 95668 18665",
      ctaHref: "tel:+919566818665",
      order: 1,
    },
    {
      title: "TNPSC AE & TNPSC JDO Batches",
      subtitle: "Coming Soon",
      body: "New batches for TNPSC AE and TNPSC JDO Civil starting soon.",
      order: 2,
    },
    {
      title: "GATE & TNPSC JDO Online Test Series",
      subtitle: "Launching October 1, 2026",
      body: "Our dedicated Online Test Series for GATE and TNPSC JDO Civil launches October 1, 2026.",
      order: 3,
    },
  ],
};

// Public — used by the homepage sections. Only ever returns active items,
// oldest-order first. No auth: this is marketing-site content.
const getPublicContent = async (req, res) => {
  try {
    const { type } = req.params;
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: "Unknown content type." });
    }
    const items = await contentItemModel
      .find({ type, active: true })
      .sort({ order: 1, createdAt: 1 })
      .lean();
    return res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("getPublicContent error:", error);
    return res.status(500).json({ success: false, message: "Failed to load content." });
  }
};

// Admin — returns every item of a type, active and inactive, for the
// Content Management page's list view.
const listContentAdmin = async (req, res) => {
  try {
    const { type } = req.params;
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: "Unknown content type." });
    }
    const items = await contentItemModel
      .find({ type })
      .sort({ order: 1, createdAt: 1 })
      .lean();
    return res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("listContentAdmin error:", error);
    return res.status(500).json({ success: false, message: "Failed to load content." });
  }
};

const createContent = async (req, res) => {
  try {
    const {
      type,
      title,
      subtitle,
      body,
      image,
      badge,
      meta,
      ctaLabel,
      ctaHref,
      order,
      active,
    } = req.body;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: "Unknown content type." });
    }
    if (!title || !title.toString().trim()) {
      return res.status(400).json({ success: false, message: "Title is required." });
    }

    // New items default to the end of their type's list unless an order
    // was explicitly given.
    let resolvedOrder = order;
    if (resolvedOrder === undefined || resolvedOrder === null || resolvedOrder === "") {
      const last = await contentItemModel
        .findOne({ type })
        .sort({ order: -1 })
        .lean();
      resolvedOrder = last ? last.order + 1 : 1;
    }

    const item = await contentItemModel.create({
      type,
      title: title.toString().trim(),
      subtitle: (subtitle || "").toString().trim(),
      body: (body || "").toString().trim(),
      image: image || null,
      badge: badge || null,
      meta: meta || null,
      ctaLabel: ctaLabel || null,
      ctaHref: ctaHref || null,
      order: resolvedOrder,
      active: active === undefined ? true : !!active,
    });

    return res.status(201).json({ success: true, data: item });
  } catch (error) {
    console.error("createContent error:", error);
    return res.status(500).json({ success: false, message: "Failed to create content item." });
  }
};

const updateContent = async (req, res) => {
  try {
    const { id } = req.params;
    const allowedFields = [
      "title",
      "subtitle",
      "body",
      "image",
      "badge",
      "meta",
      "ctaLabel",
      "ctaHref",
      "order",
      "active",
    ];
    const update = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) update[field] = req.body[field];
    });

    if (update.title !== undefined && !update.title.toString().trim()) {
      return res.status(400).json({ success: false, message: "Title is required." });
    }

    const item = await contentItemModel.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });

    if (!item) {
      return res.status(404).json({ success: false, message: "Content item not found." });
    }

    return res.status(200).json({ success: true, data: item });
  } catch (error) {
    console.error("updateContent error:", error);
    return res.status(500).json({ success: false, message: "Failed to update content item." });
  }
};

const deleteContent = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await contentItemModel.findByIdAndDelete(id);
    if (!item) {
      return res.status(404).json({ success: false, message: "Content item not found." });
    }
    return res.status(200).json({ success: true, message: "Deleted." });
  } catch (error) {
    console.error("deleteContent error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete content item." });
  }
};

// One-click migration helper for the Content Management page: for each of
// the 4 types, if the database currently has zero items of that type, it
// inserts the same real content that's hardcoded into today's homepage
// components. Types that already have items (because the admin already
// added some) are left untouched — safe to click more than once.
const seedDefaults = async (req, res) => {
  try {
    const seeded = {};
    for (const type of VALID_TYPES) {
      const count = await contentItemModel.countDocuments({ type });
      if (count === 0) {
        const docs = DEFAULT_CONTENT[type].map((item) => ({ ...item, type }));
        await contentItemModel.insertMany(docs);
        seeded[type] = docs.length;
      } else {
        seeded[type] = 0;
      }
    }
    return res.status(200).json({
      success: true,
      message: "Starter content loaded for any empty sections.",
      data: seeded,
    });
  } catch (error) {
    console.error("seedDefaults error:", error);
    return res.status(500).json({ success: false, message: "Failed to load starter content." });
  }
};

module.exports = {
  getPublicContent,
  listContentAdmin,
  createContent,
  updateContent,
  deleteContent,
  seedDefaults,
};
