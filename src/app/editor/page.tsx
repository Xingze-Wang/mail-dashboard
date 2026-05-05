// /editor — moved to /congress/editor.
import { redirect } from "next/navigation";

export default function EditorRedirect() {
  redirect("/congress/editor");
}
