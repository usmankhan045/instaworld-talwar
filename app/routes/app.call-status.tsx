export default function CallStatus() {
  return <s-page heading="Order call automation">
    <s-section heading="What this page was for">
      <s-paragraph>This was an internal dry-run workspace for preparing customer confirmation calls about order details and delivery addresses. It did not place live calls and it was separate from InstaWorld booking.</s-paragraph>
    </s-section>
    <s-section heading="Current status">
      <s-banner heading="Not enabled" tone="info">Order calls are not part of the active booking workflow. Use the Shopify order action or bulk booking page to book shipments with InstaWorld.</s-banner>
    </s-section>
    <s-stack direction="inline" gap="base"><s-button href="/app/bulk-booking" variant="primary">Open bulk booking</s-button><s-button href="/app" variant="secondary">Back to dashboard</s-button></s-stack>
  </s-page>;
}
