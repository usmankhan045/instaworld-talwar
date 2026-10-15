import '@shopify/ui-extensions';

//@ts-expect-error Shopify extension module declaration requires the generated runtime global.
declare module './src/ActionExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-expect-error Shopify extension module declaration requires the generated runtime global.
declare module './src/BulkBookExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-index.selection-action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
