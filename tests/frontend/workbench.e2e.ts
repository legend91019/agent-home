import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const session = { agentId: 'claude-code', id: 'session-1', title: '修复登录', messageCount: 1 };
    let interrupted = false;
    let edited = false;
    let removed = false;
    let workflow: any;
    let conflict = true;
    (window as any).calls = [];
    (window as any).api = new Proxy({}, { get: (_, channel) => async (input: any) => {
      (window as any).calls.push({channel,input});
      const run = {id:'run-12345678',taskId:'task-1',agentId:'codex',status:interrupted?'cancelled':'running',controllable:!interrupted};
      if(channel==='projects.list') return [{id:'p1',name:'测试项目',path:'D:/test'}];
      if(channel==='projects.capabilities') return [];
      if(channel==='projects.register') throw {code:'invalid_project',message:'项目路径无效'};
      if(channel==='config.scan') return [{id:'rule-1',kind:'rule',name:'公共规则'}];
      if(channel==='config.previewPublish') return {id:'diff-1',projectId:'p1',targetAgentId:input.targetAgentId,entries:[
        {artifactId:'rule-1',kind:'rule',sourcePath:'D:/test/rules.md',path:'D:/test/AGENTS.md',status:'changed',publishable:true},
        {artifactId:'skill-2',kind:'skill',sourcePath:'D:/test/skill/SKILL.md',path:'D:/test/.agents/skills/skill/SKILL.md',status:'new',publishable:false,reason:'来源不安全'},
      ]};
      if(channel==='config.publish') return {id:'receipt-1',diffId:input.diffId,appliedChoices:input.choices};
      if(channel==='sessions.list') return [session];
      if(channel==='handoff.create') return {id:'handoff-1'};
      if(channel==='handoff.integrity') return {readCount:1,sourceCount:1,complete:true,missing:[],largeAttachments:[],sessionRef:session};
      if(channel==='handoff.summary') return {id:'handoff-1',projectId:'p1',consumed:false};
      if(channel==='handoff.search') return removed?[]:[{index:0,role:'user',text:edited?'已清理的交接内容':'完整交接原文：请检查密码字段',timestamp:'2026-01-01'}];
      if(channel==='handoff.findings') return edited?[]:[{eventIndex:0,field:'text',kind:'secret',snippet:'请检查密码字段'}];
      if(channel==='handoff.edit'){edited=true;removed=input.edits.some((e:any)=>e.text===null);return {id:'handoff-1'}};
      if(channel==='handoff.consume') return run;
      if(channel==='tasks.list') return [{id:'task-1',title:'可中断任务',goal:'测试',status:interrupted?'cancelled':'running',runs:[run,{...run,id:'run-2',controllable:false}]}];
      if(channel==='tasks.interrupt'){interrupted=true;return {ok:true}}
      if(channel==='tasks.startRun') throw {code:'not_authenticated',message:'请先登录'};
      if(channel==='memory.list') return [{id:'native:one',agentId:'claude-code',projectId:'p1',source:'D:/test/CLAUDE.md',originalText:'保存项目约定',scope:'project',published:false}];
      if(channel==='memory.previewTransfer') return {id:'memory-diff',entryIds:input.entryIds,targetAgentId:input.targetAgentId,destination:input.destination,nativeWriteSupported:false,previewText:'[CLAUDE.md] 保存项目约定'};
      if(channel==='memory.applyTransfer') return {id:'receipt',diffId:input.diffId};
      if(channel==='workflow.start') { workflow={id:'wf-1',taskId:input.taskId,definition:input.definition,paused:false,nodes:input.definition.nodes.map((n:any,i:number)=>({id:n.id,status:i===0?'blocked':'failed'}))};return workflow; }
      if(channel==='workflow.get') return workflow;
      if(channel==='workflow.pause'){workflow.paused=true;return {ok:true}}
      if(channel==='workflow.resume'){workflow.paused=false;return workflow}
      if(channel==='workflow.approve'||channel==='workflow.retry'){workflow.nodes=workflow.nodes.map((n:any)=>n.id===input.nodeId?{...n,status:'running'}:n);return workflow}
      if(channel==='workflow.advance') return workflow;
      const proposal={id:'merge-1',workflowRunId:'wf-1',targetBranch:'main',baselineCommit:'abc123',baselineValid:true,conflicts:conflict?['src/conflict.ts']:[],branches:[{runId:'r1',agentId:'codex',branch:'wf-branch',baseCommit:'abc123',committedChanges:1,uncommittedChanges:0,untrackedFiles:0}]};
      if(channel==='merge.create') return proposal;
      if(channel==='merge.refresh'){conflict=false;return {...proposal,conflicts:[]}}
      if(channel==='merge.apply') return {ok:true,message:input.decision==='reject'?'已拒绝提案':'合并成功'};
      return {};
    }});
  });
  await page.goto('/');
  await page.getByText('测试项目', { exact: true }).click();
});

test('项目登记错误可见，配置按来源逐项选择发布', async ({page}) => {
  await page.getByRole('button',{name:'登记项目'}).click();
  await page.getByPlaceholder('项目路径，例如 D:/repo').fill('Z:/missing');
  await page.getByRole('button',{name:'登记项目'}).click();
  await expect(page.getByRole('alert')).toContainText('项目路径无效');
  await page.getByRole('button',{name:'共享配置',exact:true}).click();
  await page.getByRole('button',{name:'扫描并对 codex 预览发布'}).click();
  await expect(page.getByText('来源不安全')).toBeVisible();
  const selectors=page.locator('select').filter({has:page.locator('option[value="keep-native"]')});
  await selectors.first().selectOption('overwrite-with-shared');
  await expect(selectors.nth(1).locator('option[value="overwrite-with-shared"]')).toBeDisabled();
  await page.getByRole('button',{name:'按以上选择发布'}).click();
  await expect(page.getByRole('status')).toContainText('发布完成');
  const calls=await page.evaluate(()=>(window as any).calls);
  expect(calls.find((c:any)=>c.channel==='config.publish').input.choices).toEqual({'rule-1':'overwrite-with-shared','skill-2':'keep-native'});
});

test('选择源会话，审查原文和完整性后启动目标 Agent', async ({page}) => {
  await page.getByRole('button',{name:'对话交接',exact:true}).click();
  await expect(page.getByLabel('源会话')).toContainText('修复登录');
  await page.getByLabel('源会话').selectOption('session-1');
  await page.getByRole('button',{name:'创建交接包',exact:true}).click();
  await expect(page.getByText('完整性：完整',{exact:true})).toBeVisible();
  await expect(page.locator('pre').filter({hasText:'完整交接原文：请检查密码字段'})).toBeVisible();
  await expect(page.getByText('敏感提示：secret · text · 请检查密码字段')).toBeVisible();
  await page.getByLabel('编辑消息 1').fill('已清理的交接内容');
  await page.getByRole('button',{name:'保存交接副本'}).click();
  await expect(page.locator('pre').filter({hasText:'已清理的交接内容'})).toBeVisible();
  await expect(page.getByRole('button',{name:'启动目标 Agent'})).toBeDisabled();
  await page.getByLabel('我已审查交接原文及敏感内容').check();
  await page.getByRole('button',{name:'启动目标 Agent'}).click();
  await expect(page.getByRole('status')).toContainText('已为 codex');
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls.find((c:any) => c.channel==='handoff.create').input.session.id).toBe('session-1');
  expect(calls.find((c:any) => c.channel==='handoff.edit').input.edits).toEqual([{eventIndex:0,text:'已清理的交接内容'}]);
  expect(calls.find((c:any) => c.channel==='handoff.consume').input.targetAgentId).toBe('codex');
});

test('任务正确区分不可中断运行，并显示启动错误', async ({page}) => {
  await page.getByRole('button',{name:'任务',exact:true}).click();
  await expect(page.getByRole('button',{name:'中断运行'})).toHaveCount(1);
  await expect(page.getByText('当前不支持中断')).toBeVisible();
  await page.getByRole('button',{name:'用 claude-code 启动'}).click();
  await expect(page.getByRole('alert')).toContainText('请先登录');
  await page.getByRole('button',{name:'中断运行'}).click();
  await expect(page.getByText('状态：cancelled',{exact:true})).toBeVisible();
});

test('删除副本消息后必须保存并重新审查', async ({page}) => {
  await page.getByRole('button',{name:'对话交接',exact:true}).click();
  await page.getByLabel('源会话').selectOption('session-1');
  await page.getByRole('button',{name:'创建交接包',exact:true}).click();
  await page.getByLabel('我已审查交接原文及敏感内容').check();
  await page.getByRole('button',{name:'删除消息 1',exact:true}).click();
  await expect(page.getByRole('button',{name:'启动目标 Agent'})).toBeDisabled();
  await page.getByRole('button',{name:'保存交接副本'}).click();
  await expect(page.getByLabel('编辑消息 1')).toHaveCount(0);
  await expect(page.getByLabel('我已审查交接原文及敏感内容')).not.toBeChecked();
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls.find((c:any) => c.channel==='handoff.edit').input.edits).toEqual([{eventIndex:0,text:null}]);
});

test('编辑并行工作流，审批重试并通过合并审查', async ({page}) => {
  await page.getByRole('button',{name:'工作流',exact:true}).click();
  await page.getByLabel('工作流任务').selectOption('task-1');
  await page.getByLabel('节点 node-1 指令').fill('检查实现');
  await page.getByLabel('节点 node-1 人工审查门').check();
  await page.getByRole('button',{name:'添加并行节点'}).click();
  await page.getByLabel('节点 node-2 指令').fill('补充验证');
  await page.getByLabel('节点 node-2 写仓库').check();
  await page.getByRole('button',{name:'启动工作流',exact:true}).click();
  await page.getByRole('button',{name:'批准 node-1'}).click();
  await page.getByRole('button',{name:'重试 node-2'}).click();
  await page.getByRole('button',{name:'暂停调度'}).click();
  await page.getByRole('button',{name:'恢复调度'}).click();
  await page.getByRole('button',{name:'查看合并提案'}).click();
  await page.getByRole('button',{name:'创建合并提案'}).click();
  await expect(page.getByText('wf-branch',{exact:true})).toBeVisible();
  await expect(page.getByText('src/conflict.ts',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'应用无冲突合并'})).toBeDisabled();
  await page.getByRole('button',{name:'刷新提案'}).click();
  await page.getByLabel('我已审查分支差异与验证结果').check();
  await page.getByRole('button',{name:'应用无冲突合并'}).click();
  await expect(page.getByRole('status')).toContainText('合并成功');
  const calls=await page.evaluate(()=>(window as any).calls);
  expect(calls.find((c:any)=>c.channel==='workflow.start').input.definition.nodes[1].dependsOn).toEqual([]);
  expect(calls.find((c:any)=>c.channel==='workflow.start').input.definition.nodes[0].completionCondition).toBe('user_review');
});

test('顺序依赖可编辑，循环依赖禁止启动且冲突提案可以拒绝', async ({page}) => {
  await page.getByRole('button',{name:'工作流',exact:true}).click();
  await page.getByLabel('工作流任务').selectOption('task-1');
  await page.getByLabel('节点 node-1 指令').fill('执行步骤一');
  await page.getByRole('button',{name:'添加顺序节点'}).click();
  await page.getByLabel('节点 node-2 指令').fill('执行步骤二');
  await expect(page.getByLabel('节点 node-2 依赖')).toHaveValues(['node-1']);
  await page.getByLabel('节点 node-1 依赖').selectOption(['node-2']);
  await page.getByRole('button',{name:'启动工作流',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('循环');
  expect(await page.evaluate(()=>(window as any).calls.filter((c:any)=>c.channel==='workflow.start').length)).toBe(0);
  await page.getByLabel('节点 node-1 依赖').selectOption([]);
  await page.getByRole('button',{name:'启动工作流',exact:true}).click();
  await page.getByRole('button',{name:'查看合并提案'}).click();
  await page.getByRole('button',{name:'创建合并提案'}).click();
  await page.getByRole('button',{name:'拒绝提案'}).click();
  await expect(page.getByRole('status')).toContainText('已拒绝提案');
  await expect(page.getByRole('button',{name:'应用无冲突合并'})).toBeDisabled();
});

test('用户可选择记忆来源和目标，预览后发布为任务指导', async ({page}) => {
  await page.getByRole('button',{name:'记忆互转',exact:true}).click();
  await page.getByLabel('记忆目标 Agent').selectOption('codex');
  await page.getByRole('button',{name:'预览转给 codex'}).click();
  await expect(page.getByText('[CLAUDE.md] 保存项目约定')).toBeVisible();
  await page.getByRole('button',{name:'发布为工作台任务指导'}).click();
  await expect(page.getByRole('status')).toContainText('已发布给 codex');
  const calls=await page.evaluate(()=>(window as any).calls);
  expect(calls.find((c:any)=>c.channel==='memory.previewTransfer').input).toEqual({entryIds:['native:one'],targetAgentId:'codex',destination:'project_guidance'});
  expect(calls.find((c:any)=>c.channel==='memory.applyTransfer').input.diffId).toBe('memory-diff');
});
