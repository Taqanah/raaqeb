/**
 * The component and status page server functions: the
 * component list, form, create, edit and delete; the page list, editor,
 * create, save and delete; a page image's upload and removal. Each sits
 * behind the operator session check. Not a route file (the leading dash);
 * the component and page routes share them. A function parses with the
 * Zod schema and calls one module.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  createComponent,
  deleteComponent,
  editComponent,
  listComponents,
  readComponentForm,
} from "@/server/pages/components.ts";
import { removePageImage, uploadPageImage } from "@/server/pages/images.ts";
import {
  createPage,
  deletePage,
  listPages,
  readPageEditor,
  savePage,
} from "@/server/pages/pages.ts";
import { readInstallLanguage } from "@/server/settings/language.ts";
import {
  listSubscribers,
  removeSubscriber,
} from "@/server/subscriptions/subscriptions.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import {
  type ComponentDeleteResult,
  type ComponentFormResult,
  type ComponentListResult,
  type ComponentSaveResult,
  componentEditSchema,
  componentFormSchema,
  componentIdSchema,
  componentInputSchema,
} from "@/shared/schemas/component.ts";
import {
  type PageDeleteResult,
  type PageEditorResult,
  type PageImageResult,
  type PageListResult,
  type PageSaveResult,
  pageCreateSchema,
  pageEditSchema,
  pageIdSchema,
  pageImageRemoveSchema,
  pageImageUploadOf,
} from "@/shared/schemas/page.ts";
import {
  type SubscriberListResult,
  type SubscriberRemoveResult,
  subscriberListSchema,
  subscriberRemoveSchema,
} from "@/shared/schemas/subscription.ts";
import { operatorMiddleware } from "./-admin.ts";

export const readComponentListFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<ComponentListResult> =>
      listComponents(context.storage, Date.now())
  );

export const readComponentFormFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(componentFormSchema)
  .handler(
    ({ context, data }): Promise<ComponentFormResult> =>
      readComponentForm(context.storage, data.id)
  );

export const createComponentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(componentInputSchema)
  .handler(
    ({ context, data }): Promise<ComponentSaveResult> =>
      createComponent(context.storage, data)
  );

export const editComponentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(componentEditSchema)
  .handler(
    ({ context, data }): Promise<ComponentSaveResult> =>
      editComponent(context.storage, data.id, data.input)
  );

export const deleteComponentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(componentIdSchema)
  .handler(
    ({ context, data }): Promise<ComponentDeleteResult> =>
      deleteComponent(context.storage, data.id)
  );

export const readPageListFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<PageListResult> => listPages(context.storage)
  );

/** The install language, which a new page's language starts from. */
export const readInstallLanguageFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<Locale> => readInstallLanguage(context.storage)
  );

export const readPageEditorFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(pageIdSchema)
  .handler(
    ({ context, data }): Promise<PageEditorResult> =>
      readPageEditor(context.storage, data.id)
  );

export const createPageFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(pageCreateSchema)
  .handler(
    ({ context, data }): Promise<PageSaveResult> =>
      createPage(context.storage, data)
  );

export const savePageFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(pageEditSchema)
  .handler(
    ({ context, data }): Promise<PageSaveResult> =>
      savePage(context.storage, data.id, data.input)
  );

export const deletePageFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(pageIdSchema)
  .handler(
    ({ context, data }): Promise<PageDeleteResult> =>
      deletePage(context.storage, data.id)
  );

export const uploadPageImageFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(pageImageUploadOf)
  .handler(
    ({ context, data }): Promise<PageImageResult> =>
      uploadPageImage(context.storage, data.id, data.kind, data.file)
  );

export const removePageImageFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(pageImageRemoveSchema)
  .handler(
    ({ context, data }): Promise<PageImageResult> =>
      removePageImage(context.storage, data.id, data.kind)
  );

/** A status page's subscribers. */
export const readSubscribersFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(subscriberListSchema)
  .handler(
    ({ context, data }): Promise<SubscriberListResult> =>
      listSubscribers(
        context.storage,
        context.boot.installKey,
        data.pageId,
        Date.now()
      )
  );

export const removeSubscriberFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(subscriberRemoveSchema)
  .handler(
    ({ context, data }): Promise<SubscriberRemoveResult> =>
      removeSubscriber(context.storage, data.pageId, data.id)
  );
