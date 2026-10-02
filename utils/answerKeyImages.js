// An answer key can now carry SEVERAL screenshots (a long worked solution is
// split across a few readable images instead of one tall, zoomed-out one).
//   answerKeyImages : full ordered list of image URLs (new)
//   answerKeyImage  : always mirrors answerKeyImages[0] (legacy single field,
//                     still read by older code and by every pre-existing question)
const MAX_ANSWER_KEY_IMAGES = 20;

const cleanUrlList = (value) =>
  Array.isArray(value)
    ? value
        .filter((u) => typeof u === "string" && u.trim() !== "")
        .map((u) => u.trim())
        .slice(0, MAX_ANSWER_KEY_IMAGES)
    : [];

// Ordered, de-duplicated URLs for a question, falling back to the legacy
// single image when the question predates the list.
const getAnswerKeyImageUrls = (question) => {
  const list = cleanUrlList(question && question.answerKeyImages);
  if (list.length) return [...new Set(list)];
  const single = question && typeof question.answerKeyImage === "string" ? question.answerKeyImage.trim() : "";
  return single ? [single] : [];
};

module.exports = { MAX_ANSWER_KEY_IMAGES, cleanUrlList, getAnswerKeyImageUrls };
