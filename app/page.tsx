import Worklist from "@/components/Worklist";

/**
 * The worklist. Lead data is seeded once in the root layout via
 * `LeadsProvider`, so this route just mounts the view.
 */
export default function Home() {
  return <Worklist />;
}
