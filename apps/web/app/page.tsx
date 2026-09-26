import { redirect } from "next/navigation";

// The run history is the home page (Ruling R52); "New test" is in the header and on the history page.
export default function HomePage() {
  redirect("/runs");
}
