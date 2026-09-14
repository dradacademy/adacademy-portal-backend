const mongoose = require("mongoose");

// Phase 3: Admin CMS. A single, flexible schema backs four homepage
// sections (achievers, testimonials, gallery photos, announcements)
// instead of four near-identical models — the fields below are a
// deliberate superset, and each section's admin form + public renderer
// only reads the fields relevant to its type:
//
//   achiever:     title (name), subtitle (branch), body (story),
//                 image (photo), badge (e.g. "GATE Qualified"),
//                 meta (e.g. "GATE 2026")
//   testimonial:  title (student name), subtitle (e.g. "GATE 2026,
//                 Civil Engineering"), body (the quote)
//   gallery:      title (alt text), subtitle (category, e.g.
//                 "Facility"), image
//   announcement: title, subtitle (short date/status label), body
//                 (description), ctaLabel + ctaHref (optional)
const contentItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["achiever", "testimonial", "gallery", "announcement"],
      index: true,
    },
    title: { type: String, trim: true, maxlength: 200, default: "" },
    subtitle: { type: String, trim: true, maxlength: 200, default: "" },
    body: { type: String, trim: true, maxlength: 2000, default: "" },
    image: { type: String, trim: true, default: null },
    badge: { type: String, trim: true, maxlength: 80, default: null },
    meta: { type: String, trim: true, maxlength: 80, default: null },
    ctaLabel: { type: String, trim: true, maxlength: 120, default: null },
    ctaHref: { type: String, trim: true, maxlength: 300, default: null },
    // Lower numbers show first. New items default to the end of their type.
    order: { type: Number, default: 0 },
    // Lets an admin unpublish an item without deleting it.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

contentItemSchema.index({ type: 1, active: 1, order: 1 });

module.exports = mongoose.model("ContentItem", contentItemSchema);
