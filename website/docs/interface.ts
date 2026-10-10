/**
 * Fumadocs' interface in each language of the docs. It ships no
 * Arabic, so the words are the docs' term list's;
 * English keeps Fumadocs' own.
 */
import { uiTranslations } from "@fumadocs/base-ui/i18n";
import { i18n } from "./source.ts";

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    ar: {
      "Back to Home(404 not found page)": "العودة إلى الرئيسية",
      "Choose a language(language switcher)": "اختر اللغة",
      "Choose a language(language switcher)(aria-label)": "اختر اللغة",
      "Close Banner(banner)(aria-label)": "إغلاق اللافتة",
      "Close Search(search dialog)(aria-label)": "إغلاق البحث",
      "Close Sidebar(aria-label)": "إغلاق الشريط الجانبي",
      "Close Sidebar(sidebar)(aria-label)": "إغلاق الشريط الجانبي",
      "Collapse Sidebar(sidebar)(aria-label)": "طيّ الشريط الجانبي",
      "Copied Anchor Link(heading anchor)(aria-label)": "نُسخ رابط القسم",
      "Copied Link(accordion)(aria-label)": "نُسخ الرابط",
      "Copied Markdown(page actions)": "نُسخ Markdown",
      "Copied Text(code block)(aria-label)": "نُسخ النص",
      "Copy Anchor Link(heading anchor)(aria-label)": "نسخ رابط القسم",
      "Copy Link(accordion)(aria-label)": "نسخ الرابط",
      "Copy Markdown(page actions)": "نسخ Markdown",
      "Copy Text(code block)(aria-label)": "نسخ النص",
      "Dark(theme switcher)(aria-label)": "داكن",
      "Edit on GitHub(edit page)": "تعديل على GitHub",
      "Hide Sidebar(sidebar)": "إخفاء الشريط الجانبي",
      "Language(language switcher)": "اللغة",
      "Last updated on(page footer)": "آخر تحديث في",
      "Light(theme switcher)(aria-label)": "فاتح",
      "Next Page(pagination)": "الصفحة التالية",
      "No Headings(table of contents)": "لا عناوين",
      "No results found(search dialog)": "لا نتائج",
      "On this page(table of contents)": "في هذه الصفحة",
      "Open Search(search trigger)(aria-label)": "فتح البحث",
      "Open Sidebar(aria-label)": "فتح الشريط الجانبي",
      "Open Sidebar(sidebar)(aria-label)": "فتح الشريط الجانبي",
      "Open(page actions)": "فتح",
      "Options(aria-label)": "خيارات",
      "Page Not Found(404 not found page)": "الصفحة غير موجودة",
      "Previous Page(pagination)": "الصفحة السابقة",
      "Search(search dialog)": "بحث",
      "Search(search trigger)": "بحث",
      "Show Sidebar(sidebar)": "إظهار الشريط الجانبي",
      "System(theme switcher)(aria-label)": "حسب النظام",
      "Table of Contents(inline table of contents)": "جدول المحتويات",
      "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 not found page)":
        "ربما حُذفت الصفحة التي تبحث عنها، أو تغيّر اسمها، أو تعذّر الوصول إليها مؤقتًا.",
      "Theme(site menu)": "النسق",
      "Toggle Menu(home layout header)(aria-label)": "إظهار القائمة أو إخفاؤها",
      "Toggle Theme(theme switcher)(aria-label)": "تبديل النسق",
      "View as Markdown(page actions)": "عرض بصيغة Markdown",
      displayName: "العربية",
    },
    en: { displayName: "English" },
  });
