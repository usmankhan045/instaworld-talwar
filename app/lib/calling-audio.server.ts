export const FIXED_IVR_RECORDINGS = {
  orderChoice: {
    fileKey: "order-choice.wav",
    script: "آرڈر کنفرم کرنے کے لیے ایک دبائیں، منسوخ کرنے کے لیے دو دبائیں۔",
  },
  addressChoice: {
    fileKey: "address-choice.wav",
    script: "اگر پتہ درست ہے تو ایک دبائیں، اگر پتہ تبدیل کرنا ہے تو دو دبائیں۔",
  },
  orderConfirmed: {
    fileKey: "order-confirmed.wav",
    script: "شکریہ، آپ کا آرڈر کنفرم ہو گیا ہے۔",
  },
  orderCancelled: {
    fileKey: "order-cancelled.wav",
    script: "آپ کا آرڈر منسوخ کر دیا گیا ہے۔ تلوار اسٹور سے رابطہ کرنے کا شکریہ۔",
  },
  noInputRetry: {
    fileKey: "no-input-retry.wav",
    script: "آپ کی طرف سے کوئی جواب موصول نہیں ہوا۔ براہ کرم دوبارہ سوال سن کر ایک یا دو دبائیں۔",
  },
  invalidInput: {
    fileKey: "invalid-input.wav",
    script: "براہ کرم پہلے بتائے گئے آپشن کے مطابق ایک یا دو دبائیں۔",
  },
  addressNeedsReview: {
    fileKey: "address-needs-review.wav",
    script: "آپ کا پتہ تصدیق کے لیے روک دیا گیا ہے۔ تلوار اسٹور سے رابطہ کرنے کا شکریہ۔",
  },
} as const;

export type FixedIvrRecordingKey = keyof typeof FIXED_IVR_RECORDINGS;

export type CallingAudioJob = {
  id: string;
  shopifyOrderNumber: string;
  customerName: string;
  productSummary: string;
  normalizedAddress: string;
};

export type DynamicAudioSegment = {
  key: "greeting" | "address";
  text: string;
  outputFileKey: string;
};

export type CallAudioManifest = {
  orderNumber: string;
  fixedRecordings: Array<{
    key: FixedIvrRecordingKey;
    fileKey: string;
    script: string;
  }>;
  dynamicSegments: DynamicAudioSegment[];
};

const MAX_NAME_LENGTH = 120;
const MAX_PRODUCT_LENGTH = 500;
const MAX_ADDRESS_LENGTH = 900;

function cleanSpeechText(value: string, maxLength: number): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

/**
 * Apply only safe, known pronunciation improvements. Unknown product names
 * and customer names remain unchanged rather than being guessed incorrectly.
 */
export function normalizeSpeechPronunciation(value: string): string {
  return value
    .replace(/\bhamtaa handmade\b/gi, "حماتا ہینڈ میڈ")
    .replace(/\bhamtaa\b/gi, "حماتا")
    .replace(/\bhandmade\b/gi, "ہینڈ میڈ")
    .replace(/\bKPK\b/gi, "Khyber Pakhtunkhwa")
    .replace(/\bKP\b/gi, "Khyber Pakhtunkhwa")
    .replace(/\bNWFP\b/gi, "Khyber Pakhtunkhwa")
    .replace(/\bAJK\b/gi, "Azad Jammu Kashmir")
    .replace(/\bGB\b/gi, "Gilgit Baltistan");
}

function dynamicText(value: string, maxLength: number): string {
  return cleanSpeechText(normalizeSpeechPronunciation(value), maxLength);
}

export function buildCallAudioManifest(job: CallingAudioJob): CallAudioManifest {
  const customerName = dynamicText(job.customerName, MAX_NAME_LENGTH) || "محترم صارف";
  const productSummary = dynamicText(job.productSummary, MAX_PRODUCT_LENGTH) || "آپ کا آن لائن آرڈر";
  const address = dynamicText(job.normalizedAddress, MAX_ADDRESS_LENGTH) || "آپ کا فراہم کردہ پتہ";
  const safeOrderNumber = cleanSpeechText(job.shopifyOrderNumber, 64) || "unknown";

  return {
    orderNumber: safeOrderNumber,
    fixedRecordings: Object.entries(FIXED_IVR_RECORDINGS).map(([key, recording]) => ({
      key: key as FixedIvrRecordingKey,
      ...recording,
    })),
    dynamicSegments: [
      {
        key: "greeting",
        text: `السلام علیکم ${customerName}، تلوار اسٹور سے آپ کا ${productSummary} کا آرڈر موصول ہوا ہے۔`,
        outputFileKey: `orders/${job.id}/greeting.wav`,
      },
      {
        key: "address",
        text: `آپ کا پتہ ہے: ${address}۔`,
        outputFileKey: `orders/${job.id}/address.wav`,
      },
    ],
  };
}
