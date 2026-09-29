import type { Metadata } from "next";
import { PrintableReport } from "../../../../components/PrintableReport";

export const metadata: Metadata = { title: "Printable report" };

/** A finished run's report laid out for printing or saving as PDF (V1.1). `?preview=1` skips the automatic print dialog. */
export default async function PrintReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ preview?: string | string[] }>;
}) {
  const [{ runId }, { preview }] = await Promise.all([params, searchParams]);
  return <PrintableReport runId={runId} autoPrint={preview !== "1"} />;
}
