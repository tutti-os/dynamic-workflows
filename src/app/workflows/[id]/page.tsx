import { WorkflowWorkbench } from "@/components/workflow/WorkflowWorkbench";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WorkflowWorkbench workflowId={id} />;
}
