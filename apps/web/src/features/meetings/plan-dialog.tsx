'use client';
import { useState } from 'react';
import { Sparkles, Trash2 } from 'lucide-react';
import { Button, Dialog, DialogContent, Field, Input, Textarea } from '@teamos/ui';
import { useOrgContext } from '@/features/org/org-context';
import { usePlanMutations, type PlanTask } from './api';

/** AI proposes; a person edits and confirms. Nothing is created until "Create tasks". */
export function PlanDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { orgId } = useOrgContext();
  const { propose, apply } = usePlanMutations(orgId, projectId);
  const [goal, setGoal] = useState('');
  const [tasks, setTasks] = useState<PlanTask[] | null>(null);

  const remove = (idx: number) =>
    setTasks((ts) => ts!.filter((_, i) => i !== idx).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== idx).map((d) => (d > idx ? d - 1 : d)) })));
  const close = (o: boolean) => { if (!o) { setTasks(null); setGoal(''); } onOpenChange(o); };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Plan with AI" description="The AI suggests tasks. Review and edit them; nothing is created until you confirm.">
        {!tasks ? (
          <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setTasks((await propose.mutateAsync(goal)).tasks); }}>
            <Field label="Goal (optional if the project has a description)" htmlFor="plan-goal">
              <Textarea id="plan-goal" rows={4} value={goal} maxLength={4000} onChange={(e) => setGoal(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" type="button" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" loading={propose.isPending}><Sparkles className="h-4 w-4" aria-hidden /> Suggest tasks</Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <ul className="max-h-80 space-y-2 overflow-auto">
              {tasks.map((t, i) => (
                <li key={i} className="flex items-center gap-2" data-testid="plan-task">
                  <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
                  <Input aria-label={`Task ${i + 1} title`} value={t.title} maxLength={200} onChange={(e) => setTasks((ts) => ts!.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                  {t.dependsOn.length ? <span className="shrink-0 text-xs text-muted-foreground">after {t.dependsOn.map((d) => d + 1).join(', ')}</span> : null}
                  <Button variant="ghost" size="sm" aria-label={`Remove task ${i + 1}`} onClick={() => remove(i)}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTasks(null)}>Back</Button>
              <Button loading={apply.isPending} disabled={!tasks.length || tasks.some((t) => !t.title.trim())}
                onClick={async () => { await apply.mutateAsync(tasks); close(false); }}>Create {tasks.length} task{tasks.length === 1 ? '' : 's'}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
