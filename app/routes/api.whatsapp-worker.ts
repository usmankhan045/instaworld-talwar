import type {ActionFunctionArgs, LoaderFunctionArgs} from "react-router";
import {processWhatsAppOutbox} from "../lib/whatsapp/outbox.server.ts";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("Authorization") === `Bearer ${secret}`);
}

export async function loader({request}: LoaderFunctionArgs) {
  if (!authorized(request)) return new Response("Unauthorized", {status: 401});
  const result = await processWhatsAppOutbox();
  return Response.json({ok: true, ...result});
}

export async function action({request}: ActionFunctionArgs) {
  return loader({request} as LoaderFunctionArgs);
}
