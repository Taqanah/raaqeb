/**
 * The API reference's own words in each language: headings, table
 * headers and the joins between machine values. The OpenAPI document's
 * texts stay as it writes them, in English, the API's contract.
 */
import { type Locale, locales } from "@/shared/i18n/locale.ts";

export interface ApiLabels {
  readonly answer: string;
  readonly body: string;
  /** Joins two items of a list in running text. */
  readonly comma: string;
  readonly description: string;
  readonly event: string;
  readonly headers: string;
  readonly in: string;
  /** Where a parameter goes, by its OpenAPI `in`; one not named here shows as written. */
  readonly locations: Readonly<Record<string, string>>;
  readonly matching: string;
  readonly name: string;
  readonly optional: string;
  readonly parameters: string;
  readonly requestBody: string;
  readonly responses: string;
  readonly status: string;
  /** Names a response's body by its status, in the language's word order. */
  readonly statusBody: (status: string) => string;
  readonly type: string;
  readonly whenAndWhat: string;
}

export const apiLabels: Readonly<Record<Locale, ApiLabels>> = {
  ar: {
    answer: "الإجابة",
    body: "المحتوى",
    comma: "، ",
    description: "الوصف",
    event: "الحدث",
    headers: "الترويسات",
    in: "الموضع",
    locations: { header: "الترويسة", path: "المسار", query: "الاستعلام" },
    matching: "يطابق",
    name: "الاسم",
    optional: "اختياري",
    parameters: "المعلَمات",
    requestBody: "محتوى الطلب",
    responses: "الاستجابات",
    status: "رمز الحالة",
    statusBody: (status) => `محتوى \`${status}\``,
    type: "النوع",
    whenAndWhat: "متى يُرسل وما يحمله",
  },
  en: {
    answer: "Answer",
    body: "Body",
    comma: ", ",
    description: "Description",
    event: "Event",
    headers: "Headers",
    in: "In",
    locations: {},
    matching: "matching",
    name: "Name",
    optional: "optional",
    parameters: "Parameters",
    requestBody: "Request body",
    responses: "Responses",
    status: "Status",
    statusBody: (status) => `\`${status}\` body`,
    type: "Type",
    whenAndWhat: "When and what",
  },
};

/** The labels of the page's language; a language the reference has no words for reads English. */
export function labelsFor(locale: string | undefined): ApiLabels {
  return apiLabels[locales.find((l) => l === locale) ?? "en"];
}
