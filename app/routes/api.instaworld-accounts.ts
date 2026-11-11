import type {LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import {listInstaWorldAccounts} from "../lib/instaworld-accounts.server";

export async function loader({request}: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {status: 204, headers: corsHeaders()});
  }
  const {session} = await authenticate.admin(request);
  return Response.json(
    {accounts: await listInstaWorldAccounts(session.shop)},
    {headers: corsHeaders()},
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
