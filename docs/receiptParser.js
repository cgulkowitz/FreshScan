// receiptParser.js
// Clean OCR text -> extract only likely grocery items (name + optional price)
// Removes address/payment/totals/card/merchant metadata lines.

const BAD_LINE_PATTERNS = [
  // common headers/merchant metadata
  /\b(store|merchant|location|cashier|register|terminal|lane|transaction|trx|receipt|invoice)\b/i,
  /\b(thank you|visit us|survey|customer|service|www\.|http|\.com)\b/i,
  /\b(phone|tel|call)\b/i,

  // address-ish patterns
  /\b(avenue|ave|street|st\.|road|rd\.|blvd|boulevard|drive|dr\.|lane|ln\.|plaza|suite|ste\.|floor)\b/i,
  /\b(city|state|zip)\b/i,
  /\b\d{5}(-\d{4})?\b/, // zip

  // totals/payment
  /\b(subtotal|total|tax|vat|balance|change|amount|due)\b/i,
  /\b(cash|credit|debit|visa|mastercard|amex|discover|card)\b/i,
  /\b(approval|auth|authorized|ref|reference|aid|tvr|tsi|arc|ic)\b/i,

  // dates/times
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b\d{1,2}:\d{2}\b/,
  /\b(am|pm)\b/i,

  // loyalty / coupons
  /\b(member|loyalty|points|savings|coupon|promo|discount)\b/i,
];

// strong sensitive patterns (always remove)
const SENSITIVE_PATTERNS = [
  /\b\d{12,19}\b/g,                 // possible card numbers
  /\b(x{2,}\d{2,4})\b/gi,            // masked cards like XXXX1234
  /\b(visa|mastercard|amex|discover)\b/gi,
];

function normalizeLine(line) {
  return line
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeSensitive(text) {
  let t = text;
  for (const re of SENSITIVE_PATTERNS) t = t.replace(re, "");
  return t;
}

function looksLikeBadLine(line) {
  if (!line) return true;

  // too short / mostly symbols
  const letters = (line.match(/[A-Za-z]/g) || []).length;
  const digits = (line.match(/[0-9]/g) || []).length;

  if (letters === 0 && digits === 0) return true;
  if (letters < 2 && digits > 6) return true; // mostly numbers
  if (/^[-=*_.]+$/.test(line)) return true;

  // explicit bad patterns
  for (const re of BAD_LINE_PATTERNS) {
    if (re.test(line)) return true;
  }

  return false;
}

// Extract a price at end of line like "ITEM NAME 4.99" or "ITEM  4.99"
// Accepts 1.00, 10.00, 0.99 etc
function extractEndPrice(line) {
  const m = line.match(/(\d{1,3}(?:,\d{3})*|\d+)\.\d{2}\s*$/);
  if (!m) return { name: line, price: null };
  const price = parseFloat(m[0].replace(/,/g, "").trim());
  const name = line.slice(0, m.index).trim();
  return { name, price };
}

// Heuristic: an item line usually has some letters, not only metadata,
// and often has a price OR looks like a product name.
function looksLikeItemLine(line) {
  const letters = (line.match(/[A-Za-z]/g) || []).length;
  if (letters < 3) return false;

  // avoid lines that are clearly units/weights totals
  if (/\b(lb|lbs|oz|kg|g|gal|qt|pt)\b/i.test(line) && /\btotal\b/i.test(line)) return false;

  // avoid "TARE" / "ITEM COUNT" etc.
  if (/\b(tare|item count|items?)\b/i.test(line)) return false;

  return true;
}

export function parseReceiptItems(rawText) {
  if (!rawText || typeof rawText !== "string") return [];

  // remove sensitive data globally first
  const cleanedText = removeSensitive(rawText);

  const lines = cleanedText
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  const candidates = [];

  for (const line of lines) {
    if (looksLikeBadLine(line)) continue;

    // remove leftover tiny sensitive fragments
    const safeLine = removeSensitive(line).trim();
    if (!safeLine) continue;

    // split cases where OCR sticks multiple items on one line with "  " gaps
    const chunks = safeLine.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);

    for (const chunk of chunks) {
      if (looksLikeBadLine(chunk)) continue;
      if (!looksLikeItemLine(chunk)) continue;

      const { name, price } = extractEndPrice(chunk);

      // if price exists but name is empty, skip
      if (!name || name.length < 2) continue;

      // final cleanup: remove trailing codes like "F" "T" etc
      const finalName = name.replace(/\s+[A-Z]$/i, "").trim();

      // avoid duplicates
      candidates.push({
        name: finalName,
        price: Number.isFinite(price) ? price : null,
        raw: chunk
      });
    }
  }

  // Deduplicate by normalized name
  const seen = new Set();
  const items = [];
  for (const c of candidates) {
    const key = c.name.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name: c.name, price: c.price });
  }

  return items;
}
