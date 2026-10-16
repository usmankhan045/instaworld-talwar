import type {LoaderFunctionArgs} from "react-router";
import {authenticate} from "../shopify.server";
import {listInstaWorldAccounts} from "../lib/instaworld-accounts.server";

export async function loader({request}: LoaderFunctionArgs) {
  const {session} = await authenticate.admin(request);
  return Response.json({accounts: await listInstaWorldAccounts(session.shop)});
}
