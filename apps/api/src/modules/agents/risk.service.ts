import { Inject, Injectable } from '@nestjs/common';
import { analyzeRisks, type RiskFinding } from '@teamos/shared';
import type { RequestActor } from '../../common/actor';
import { DbService } from '../../db/db.service';
import { AgentToolbox } from './agent-tools';

export interface ProjectRisk {
  projectId: string;
  workspaceId: string;
  key: string;
  name: string;
  dueDate: string | null;
  counts: { high: number; medium: number; low: number };
  findings: RiskFinding[];
}

@Injectable()
export class RiskService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  async analyze(actor: RequestActor, opts: { projectId?: string; workspaceId?: string }): Promise<{ today: string; projects: ProjectRisk[] }> {
    const today = new Date().toISOString().slice(0, 10);
    const snaps = await new AgentToolbox(this.dbs, actor).projectSnapshots(opts);
    const projects = snaps.map((s) => {
      const findings = analyzeRisks({ tasks: s.tasks, dependencies: s.dependencies, today, projectDueDate: s.project.dueDate });
      return {
        projectId: s.project.id, workspaceId: s.project.workspaceId, key: s.project.key, name: s.project.name, dueDate: s.project.dueDate,
        counts: {
          high: findings.filter((f) => f.severity === 'HIGH').length,
          medium: findings.filter((f) => f.severity === 'MEDIUM').length,
          low: findings.filter((f) => f.severity === 'LOW').length,
        },
        findings,
      };
    });
    // riskiest projects first
    projects.sort((a, b) => b.counts.high - a.counts.high || b.counts.medium - a.counts.medium || a.name.localeCompare(b.name));
    return { today, projects };
  }
}
