/**
 * Workflow 静态校验：在调度前确保依赖图合法。
 * 仅依赖共享契约类型，不触碰任何持久化细节。
 */
import { WorkflowDef } from "../../shared/contracts";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 校验一个 WorkflowDef：
 *  - 拒绝重复节点 id（"duplicate node id"）。
 *  - 拒绝 dependsOn 引用了不存在的节点（"unknown dependency"）。
 *  - 拒绝依赖图中的环（拓扑排序无法完成时 -> "cycle detected"）。
 * 否则视为合法。
 */
export function validateWorkflow(def: WorkflowDef): ValidationResult {
  const errors: string[] = [];

  // 1) 重复 id 检测。
  const seen = new Set<string>();
  for (const n of def.nodes) {
    if (seen.has(n.id)) {
      errors.push(`duplicate node id: ${n.id}`);
    }
    seen.add(n.id);
  }

  // 2) 未知依赖检测。
  for (const n of def.nodes) {
    for (const dep of n.dependsOn) {
      if (!seen.has(dep)) {
        errors.push("unknown dependency");
      }
    }
  }

  // 3) 环检测：Kahn 拓扑排序。indegree = 依赖数量，依赖者入边减一。
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of def.nodes) {
    indegree.set(n.id, 0);
    dependents.set(n.id, []);
  }
  for (const n of def.nodes) {
    for (const dep of n.dependsOn) {
      if (!seen.has(dep)) continue; // 重复/未知依赖已在上面报错，这里跳过避免越界。
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      dependents.get(dep)!.push(n.id);
    }
  }

  const queue: string[] = [];
  for (const n of def.nodes) {
    if ((indegree.get(n.id) ?? 0) === 0) queue.push(n.id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const dep of dependents.get(id)!) {
      const next = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
  }

  if (processed < def.nodes.length) {
    errors.push("cycle detected");
  }

  return { valid: errors.length === 0, errors };
}
