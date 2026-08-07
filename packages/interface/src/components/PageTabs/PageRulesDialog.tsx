import { useState, type ReactElement, type ReactNode } from 'react';
import {
  Ban,
  CopyPlus,
  GitFork,
  Hand,
  Layers,
  Milestone,
  MousePointerClick,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import './PageRulesDialog.css';

type SectionId = 'model' | 'trigger' | 'notrigger' | 'click' | 'instance' | 'rel' | 'phase';

const NAV: ReadonlyArray<{ id: SectionId; title: string; icon: LucideIcon }> = [
  { id: 'model', title: '层级模型', icon: Layers },
  { id: 'trigger', title: '会开页签', icon: MousePointerClick },
  { id: 'notrigger', title: '不开页签', icon: Ban },
  { id: 'click', title: '点击逻辑', icon: Hand },
  { id: 'instance', title: '插件 × 页签', icon: CopyPlus },
  { id: 'rel', title: '插件栏 / 对话流', icon: GitFork },
  { id: 'phase', title: '分期与开放问题', icon: Milestone },
];

function Card({ head, children }: { head: string; children: ReactNode }): ReactElement {
  return (
    <div className="pr-card">
      <div className="pr-card-h">{head}</div>
      {children}
    </div>
  );
}

const Yes = ({ children }: { children: ReactNode }) => <span className="pr-yes">{children}</span>;
const No = ({ children }: { children: ReactNode }) => <span className="pr-no">{children}</span>;

function ModelSection(): ReactElement {
  return (
    <>
      <div className="pr-lead">
        页签（Document Tab）是<b>面板的父层级</b>：一个页签 = 一份正在编辑的东西，页签内部由 Layout 决定面板怎么排。它不是插件切换，也不是 dock 格子里的叶子 tab。Studio 现在<b>只有一个编辑器外壳</b>（不再有 Edit / AI 两种模式），所以页签栏全局只有一条。
      </div>
      <Card head="信息架构">
        <pre className="pr-tree">{`Project 项目
└─ `}<i>Studio 编辑器外壳（顶栏 · 插件栏 · 对话流 · 文件资源管理器）</i>{`
   └─ `}<b>DocumentTab 文档页签（新增层）</b>{`          `}<i>← 我在编这份东西</i>{`
      └─ `}<i>Layout 布局（dock 树）</i>{`              `}<i>← 这份东西的面板怎么排</i>{`
         └─ `}<i>Panel 面板（视口 / Details / 插件子面板）</i></pre>
      </Card>
      <div className="pr-flow">
        <div className="pr-node">
          <div className="n-t">插件栏 Plugin</div>
          <div className="n-d">入口与发现，类比浏览器书签栏。回答「我能打开什么」，本身不是页签。</div>
        </div>
        <div className="pr-node brand">
          <div className="n-t">页签 Document Tab</div>
          <div className="n-d">打开后的工作面实例，类比浏览器标签页。回答「我现在在编什么」。</div>
        </div>
        <div className="pr-node">
          <div className="n-t">对话流 Chat</div>
          <div className="n-d">外壳级常驻，不属于任何页签。回答「谁在帮我改」。</div>
        </div>
      </div>
      <Card head="命名消歧（必须遵守）">
        <table className="pr-tbl">
          <tbody>
            <tr><th style={{ width: 150 }}>说法</th><th>指什么</th></tr>
            <tr><td><code>页签 / Document Tab</code></td><td>顶栏文档级页签，本次新增的一等公民</td></tr>
            <tr><td><code>插件切换</code></td><td>点插件栏换主面板内容，<b>不叫</b>换页签</td></tr>
            <tr><td><code>panel stack</code></td><td>dock 同一格子里叠放面板的叶子 tab（原来也被叫 tab）</td></tr>
            <tr><td><code>chat session</code></td><td>对话流里的会话切换（主会话 / 角色设定 …）</td></tr>
            <tr><td><code>Workbench</code></td><td><b>已废弃</b>的旧说法。现在只有一个编辑器外壳，不要再用它描述页签或插件</td></tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

function TriggerSection(): ReactElement {
  return (
    <>
      <div className="pr-lead">
        触发条件 = <b>打开一份可编辑的文档实例</b>，不是打开任意面板。同一份文档已打开时只聚焦，不重复开。
      </div>
      <Card head="按操作入口">
        <table className="pr-tbl">
          <tbody>
            <tr><th style={{ width: 190 }}>入口</th><th>对象</th><th style={{ width: 72 }}>开页签</th><th>结果</th></tr>
            <tr><td>启动项目</td><td>默认场景 <code>forge.json.defaultScene</code></td><td><Yes>开</Yes></td><td>常驻场景页签（不可关闭，对应 UE Level Tab）</td></tr>
            <tr><td>文件资源管理器 <b>双击</b></td><td>可编辑文件</td><td><Yes>开</Yes></td><td>按文件类型决定页签类型与 Layout（见下表）</td></tr>
            <tr><td>右键 → <b>在资产编辑器中打开</b></td><td>可编辑文件</td><td><Yes>开</Yes></td><td>同双击</td></tr>
            <tr><td>插件栏点击（插件声明 <code>opens:&quot;document-tab&quot;</code>）</td><td>3D 角色 / 低多边形</td><td><Yes>开</Yes></td><td>开该插件的一个<b>文档实例</b>页签；已有实例则聚焦最近一个</td></tr>
            <tr><td>右键插件 → <b>在新标签页中打开</b></td><td>已安装插件</td><td><Yes>开</Yes></td><td>新建可切换工作面页签，标题 = 插件名；页签内可继续切编辑器 / 其它插件</td></tr>
            <tr><td>对话流产物卡「打开」</td><td>Agent 新产出的资产</td><td><Yes>开</Yes></td><td>默认<b>不自动开</b>，用户点「打开」才开</td></tr>
            <tr><td>新建资产 → 「创建并编辑」</td><td>新建的资产</td><td><Yes>开</Yes></td><td>创建完成后直接聚焦新页签</td></tr>
            <tr><td>页签栏 <b>「+」</b></td><td>空白文档</td><td><Yes>开</Yes></td><td>单击开未命名场景页签；<b>右键</b>选类型（代码 / Markdown / 插件新实例）</td></tr>
          </tbody>
        </table>
      </Card>
      <Card head="按文件类型（双击文件资源管理器中的文件）">
        <table className="pr-tbl">
          <tbody>
            <tr><th style={{ width: 210 }}>文件</th><th style={{ width: 130 }}>页签类型</th><th>Layout</th></tr>
            <tr><td><code>*.scene.json · scene.pack.json</code></td><td>场景文档</td><td>场景视口 ▸ 大纲 · Details</td></tr>
            <tr><td><code>.glb · .gltf · .fbx</code></td><td>资产编辑 · 3D</td><td>资产视口 ▸ Details（导入 / 材质槽）</td></tr>
            <tr><td><code>.png · .jpg · .webp · .hdr</code></td><td>资产编辑 · 图像</td><td>图像预览 ▸ Details（导入设置）</td></tr>
            <tr><td><code>.mp3 · .wav · .ogg</code></td><td>资产编辑 · 音频</td><td>波形 ▸ Details（压缩 / 循环）</td></tr>
            <tr><td><code>.ttf · .otf · .woff2</code></td><td>资产编辑 · 字体</td><td>字样预览 ▸ Details</td></tr>
            <tr><td><code>*.pack.json</code>（非场景）</td><td>资产包</td><td>子资产列表 ▸ Details</td></tr>
            <tr><td><code>.ts · .tsx · .js · .py</code></td><td>代码文档</td><td>代码编辑器 ▸ 问题 · 符号</td></tr>
            <tr><td><code>.md</code></td><td>文档</td><td>Markdown 预览 ▸ 大纲</td></tr>
            <tr><td><code>forge.json · package.json</code></td><td>配置文档</td><td>结构化编辑器 ▸ 校验结果</td></tr>
            <tr><td><code>*.meta.json</code>（sidecar）</td><td><No>不开</No></td><td>跟随源资产：聚焦源资产页签的 Details</td></tr>
            <tr><td><code>*.colliders.json</code> 等数据</td><td><No>不开</No></td><td>在当前场景页签内可视化</td></tr>
            <tr><td>文件夹</td><td><No>不开</No></td><td>在文件资源管理器内进入目录</td></tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

function NoTriggerSection(): ReactElement {
  return (
    <>
      <div className="pr-lead">
        下面这些都<b>不是</b>「打开一份文档」，因此不产生页签。判据：它改变的是<b>选择</b>、<b>面板可见性</b>或<b>外壳状态</b>，而不是编辑对象。
      </div>
      <Card head="选择与浏览">
        <ul className="pr-ul">
          <li>文件资源管理器<b>单击</b>文件 → 仅选中 + 右侧预览栏（预览栏<b>不开</b>页签，打开请双击或右键）</li>
          <li>双击文件夹 → 进入目录</li>
          <li>场景物大纲里选中 Actor → 只更新 Details</li>
          <li>视口里点选物体 → 只改选择</li>
        </ul>
      </Card>
      <Card head="面板 / 布局级操作（Layout 内部，不升级为页签）">
        <ul className="pr-ul">
          <li>顶栏「窗口」菜单显隐面板 → Panel 级</li>
          <li>底部 dock 切「文件资源管理器 / 时间轴」→ 外壳 dock 内的 panel stack 级</li>
          <li>拖动分割线、收起左栏 / 收起 dock → Layout 级</li>
          <li>切换编辑模式 / 视图镜头（如 game / edit lens）→ 仍在当前页签内</li>
        </ul>
      </Card>
      <Card head="外壳级（跨页签常驻）">
        <ul className="pr-ul">
          <li>点插件栏里 <b>panel 型</b>插件（默认）→ 在当前页签 Layout 内接管主面板，选择记在该页签上，切走再回来会恢复</li>
          <li>状态栏抽屉：检查点 / 事件 / 日志 / 终端 → 外壳抽屉</li>
          <li>设置、插件商店、发布 → 模态或外壳级页面</li>
          <li>对话流切会话（主会话 / 角色设定）→ chat session 级，与页签无绑定</li>
        </ul>
      </Card>
    </>
  );
}

function ClickSection(): ReactElement {
  return (
    <>
      <div className="pr-lead">
        页签栏的手势与状态迁移。<b>永不空态</b>：关掉最后一个可关页签会回到常驻场景页签。
      </div>
      <Card head="手势 → 行为">
        <table className="pr-tbl">
          <tbody>
            <tr><th style={{ width: 200 }}>手势</th><th>行为</th></tr>
            <tr><td>左键单击页签</td><td>激活：切换 Layout 与 Details 上下文；不重载文档、不重置视口状态</td></tr>
            <tr><td>单击<b>已激活</b>页签</td><td>无操作（不折叠、不关闭）；若插件正接管主面板，则退回该页签自己的 Layout</td></tr>
            <tr><td>打开<b>已存在</b>的文档</td><td>聚焦已有页签并闪烁 600ms 提示，不重复开</td></tr>
            <tr><td>悬停页签</td><td>出现关闭按钮</td></tr>
            <tr><td>点关闭按钮 / <b>中键</b>点击</td><td>关闭当前页签（常驻页签忽略）</td></tr>
            <tr><td>右键页签</td><td>菜单：关闭 · 关闭其他 · 关闭右侧全部 · 复制路径</td></tr>
            <tr><td>拖拽页签</td><td>初版：同栏重排。拖出成浮窗留到产品化阶段</td></tr>
            <tr><td><span className="pr-kbd">⌘/Ctrl W</span></td><td>关闭当前页签（常驻页签忽略）</td></tr>
            <tr><td><span className="pr-kbd">Ctrl Tab</span></td><td>切到下一个页签（循环）</td></tr>
            <tr><td><span className="pr-kbd">⌘/Ctrl 1…9</span></td><td>跳到第 n 个页签</td></tr>
            <tr><td>页签过多</td><td>横向滚动 + 「全部页签」下拉列出（含隐藏项）</td></tr>
          </tbody>
        </table>
      </Card>
      <Card head="状态模型">
        <pre className="pr-tree">{`state = { tabs: DocumentTab[], activeId }

DocumentTab = {
  id,          `}<i>{'// 去重键 = kind + ":" + path（插件页签用 plugin:name）'}</i>{`
  kind,        `}<i>{'// scene | model | image | audio | font | pack | code | doc | config | plugin'}</i>{`
  title, path,
  layout,      `}<i>{'// dock 树；初版按 kind 给默认布局'}</i>{`
  source,      `}<i>{'// 触发来源，仅用于演示与埋点'}</i>{`
  pinned       `}<i>{'// 常驻页签（默认场景）不可关闭'}</i>{`
}`}</pre>
      </Card>
      <Card head="API 草图">
        <pre className="pr-tree">{`openDocumentTab({ kind, path, title, source })   `}<i>{'// 已存在 → 聚焦；否则新建 + 激活'}</i>{`
focusDocumentTab(id)
closeDocumentTab(id, { force })
moveDocumentTab(id, index)
getActiveDocument()                              `}<i>{'// 供 Details / 对话流取上下文'}</i></pre>
      </Card>
      <Card head="关闭后的焦点规则">
        <ul className="pr-ul">
          <li>关闭非激活页签 → 焦点不动</li>
          <li>关闭激活页签 → 激活右侧邻居；没有右侧则激活左侧</li>
          <li>关光所有可关页签 → 回到常驻场景页签</li>
        </ul>
      </Card>
    </>
  );
}

function InstanceSection(): ReactElement {
  return (
    <>
      <div className="pr-lead">
        「在两个页签里打开同一个插件，内容是延续的吗？」答：<b>取决于是不是同一份文档</b>。页签的身份是<code>插件 + 文档实例</code>，不是插件本身。同插件同文档只会有一个页签；同插件不同文档会有两个页签，<b>各自独立、互不延续</b>。而插件自己的版本、凭据、额度、后台队列是<b>插件级单例</b>，所有页签共享一份。
      </div>
      <Card head="状态归属（实现时的分工依据）">
        <table className="pr-tbl">
          <tbody>
            <tr><th style={{ width: 150 }}>状态</th><th style={{ width: 120 }}>归属</th><th>切到同插件的另一个页签时</th></tr>
            <tr><td>输入 / 参数草稿</td><td><Yes>实例私有</Yes></td><td>各自保留自己的，互不影响</td></tr>
            <tr><td>当前生成任务与进度</td><td><Yes>实例私有</Yes></td><td>各自跑各自的，进度不串</td></tr>
            <tr><td>结果 / 视口相机 / 选择</td><td><Yes>实例私有</Yes></td><td>切回来恢复到离开时的样子</td></tr>
            <tr><td>撤销栈</td><td><Yes>实例私有</Yes></td><td>撤销只影响本页签，绝不跨页签回滚</td></tr>
            <tr><td>插件栏当前选中的 panel 型插件</td><td><Yes>页签私有</Yes></td><td>切走再切回这个页签会恢复该选择；其它页签不受影响</td></tr>
            <tr><td>插件版本 / 安装状态</td><td><No>插件级</No></td><td>共享；更新或卸载一次性影响所有页签</td></tr>
            <tr><td>账号 / 凭据 / 额度</td><td><No>插件级</No></td><td>共享；一个页签消耗额度，另一个也看到减少</td></tr>
            <tr><td>后台任务队列</td><td><No>插件级</No></td><td>共享；页签关掉后台任务仍继续</td></tr>
            <tr><td>全局偏好（默认模型等）</td><td><No>插件级</No></td><td>共享；改一处全部生效</td></tr>
          </tbody>
        </table>
      </Card>
      <Card head="什么时候会出现第二个实例">
        <table className="pr-tbl">
          <tbody>
            <tr><th style={{ width: 210 }}>操作</th><th>结果</th></tr>
            <tr><td>再点一次插件栏图标</td><td><b>不新建</b>：聚焦该插件最近一个页签</td></tr>
            <tr><td>页签内「再开一个实例」/ 右键「在新标签页中打开」</td><td>新建一个独立实例，状态从零开始</td></tr>
            <tr><td>双击另一份该插件能编辑的资产</td><td>以该资产为文档新建实例；同一资产再双击则聚焦已有</td></tr>
            <tr><td>对话流里点另一个产物的「打开」</td><td>同上，按产物路径去重</td></tr>
          </tbody>
        </table>
      </Card>
      <Card head="宿主 ↔ 插件契约（实现要点）">
        <pre className="pr-tree">{`plugin.mount(container, { instanceId, doc })   `}<i>{'// 新实例：建立私有状态'}</i>{`
plugin.activate(instanceId)                    `}<i>{'// 切到该页签：恢复视口 / 选择 / 草稿'}</i>{`
plugin.deactivate(instanceId)                  `}<i>{'// 切走：保存快照，后台任务继续'}</i>{`
plugin.dispose(instanceId)                     `}<i>{'// 关页签：只清这一个实例'}</i>{`
plugin.isDirty(instanceId)

// 插件级单例（跨实例共享）
plugin.shared = { version, account, credits, queue, prefs }`}</pre>
      </Card>
      <Card head="不进页签的插件">
        <ul className="pr-ul">
          <li>没有「文档」概念的插件（插件商店、设置、日志、诊断）→ 永远单例，走主面板或模态</li>
          <li>轻量工具（取色、快捷生成）→ 留在侧栏 / 面板，不值得一个页签</li>
        </ul>
      </Card>
    </>
  );
}

function RelSection(): ReactElement {
  return (
    <>
      <div className="pr-lead">
        一句话边界：<b>插件栏管「能打开什么」，页签管「现在在编什么」，对话流管「谁在帮我改」。</b>页签栏只横跨 Layout 区；插件栏与对话流是外壳级，切页签时不变。
      </div>
      <Card head="插件栏 ↔ 页签">
        <div className="pr-arrows">
          <div className="pr-arrow"><span className="a-k">插件栏 → 页签</span><span>插件栏是书签，不等于页签。默认点插件 = 在<b>当前页签的 Layout 内</b>接管主面板；声明 <code>opens:&quot;document-tab&quot;</code> 的左键才开/聚焦页签。任意已安装插件均可<b>右键 → 在新标签页中打开</b>强制新建实例。</span></div>
          <div className="pr-arrow"><span className="a-k">一个插件 → 几个页签</span><span>可以有多个，因为页签的身份是<b>插件 + 文档实例</b>；实例之间状态不延续，插件级状态共享。</span></div>
          <div className="pr-arrow"><span className="a-k">页签 → 插件栏</span><span>插件栏高亮跟随当前页签所属插件；切页签不改动插件的安装状态与排序。卸载插件时，其全部实例页签一并关闭。</span></div>
          <div className="pr-arrow"><span className="a-k">不要做</span><span>不要把设置、日志、商店这类轻量工具升级成页签——它们没有「文档实例」。</span></div>
        </div>
      </Card>
      <Card head="对话流 ↔ 页签">
        <div className="pr-arrows">
          <div className="pr-arrow"><span className="a-k">页签 → 对话流</span><span>当前页签是对话的<b>默认上下文</b>：页签工具条「引用到对话流」把 <code>@文档</code> 注入 composer。</span></div>
          <div className="pr-arrow"><span className="a-k">对话流 → 页签</span><span>消息里的资源 pill、产物卡「打开」= <code>openDocumentTab</code>（去重聚焦）。Agent 产出<b>默认不自动开页签</b>，只给「打开」按钮。</span></div>
          <div className="pr-arrow"><span className="a-k">会话与页签</span><span>对话流常驻，切页签<b>不切会话</b>；chat session 与页签不做一一绑定。</span></div>
        </div>
      </Card>
      <Card head="三者同时在场时的职责表">
        <table className="pr-tbl">
          <tbody>
            <tr><th style={{ width: 120 }}>区域</th><th style={{ width: 120 }}>层级</th><th>切页签时</th><th>谁拥有它</th></tr>
            <tr><td>顶栏页签栏</td><td>DocumentTab</td><td>—</td><td>宿主外壳（全局一条）</td></tr>
            <tr><td>左栏 / 中央视口</td><td>Layout ▸ Panel</td><td><b>随页签整体切换</b></td><td>当前页签</td></tr>
            <tr><td>底部文件资源管理器</td><td>外壳（常驻抽屉）</td><td>不变，跨页签可用</td><td>宿主（类比 UE Content Drawer）</td></tr>
            <tr><td>右侧插件栏</td><td>外壳（书签）</td><td>不变，仅高亮跟随</td><td>宿主</td></tr>
            <tr><td>右侧对话流</td><td>外壳（常驻）</td><td>不变，仅上下文跟随</td><td>宿主</td></tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

function PhaseSection(): ReactElement {
  return (
    <>
      <div className="pr-phase">
        <Card head="初版（本演示范围）">
          <ul className="pr-ul">
            <li>编辑器外壳顶部一条全局页签栏</li>
            <li>打开资产 / 场景 / 代码文档 → 新建页签 + 默认 Layout</li>
            <li>同文档去重聚焦、关闭、切换、重排</li>
            <li>插件按 <code>opens</code> 声明决定是否开页签；插件页签按实例隔离</li>
            <li>脏标记与关闭二次确认</li>
          </ul>
        </Card>
        <Card head="产品化阶段（本轮不做）">
          <ul className="pr-ul">
            <li>拖出成浮窗 / 跨屏，及 UE 式「Asset Editor Open Location」偏好</li>
            <li>Last Docked 记忆、页签级 Layout 持久化与布局预设</li>
            <li>页签组 / 分屏对比、会话与页签绑定</li>
            <li>大量页签的会话恢复与内存回收策略</li>
          </ul>
        </Card>
      </div>
      <Card head="待产品拍板（含推荐）">
        <div className="pr-q"><div className="q-t">A · 第一批进页签的对象范围？</div><div className="q-a">推荐：<em>资产编辑 + 场景文档 + 代码/文档文件</em>；marketplace 插件个案声明是否开页签，不一律升级。</div></div>
        <div className="pr-q"><div className="q-t">B · 页签栏是否全局唯一一条？</div><div className="q-a">推荐：<em>全局一条，跟随项目</em>。Studio 已经没有 Edit / AI 两种模式。</div></div>
        <div className="pr-q"><div className="q-t">C · 插件默认走页签还是主面板？</div><div className="q-a">推荐：<em>默认在当前页签内接管主面板</em>；仅 <code>opens:&quot;document-tab&quot;</code> 的插件走页签。</div></div>
        <div className="pr-q"><div className="q-t">F · 同一插件的多个页签，状态要不要互通？</div><div className="q-a">推荐：<em>实例私有状态不互通，插件级状态共享</em>。</div></div>
        <div className="pr-q"><div className="q-t">D · 是否引入 VSCode 式「预览页签」？</div><div className="q-a">推荐：<em>不引入</em>。保持 UE 语义「单击选中、双击打开」。</div></div>
        <div className="pr-q"><div className="q-t">E · chat session 是否与页签一一绑定？</div><div className="q-a">推荐：<em>初版不绑定</em>，只做上下文注入。</div></div>
      </Card>
    </>
  );
}

const SECTIONS: Record<SectionId, () => ReactElement> = {
  model: ModelSection,
  trigger: TriggerSection,
  notrigger: NoTriggerSection,
  click: ClickSection,
  instance: InstanceSection,
  rel: RelSection,
  phase: PhaseSection,
};

export function PageRulesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const [active, setActive] = useState<SectionId>('model');
  const current = NAV.find((n) => n.id === active) ?? NAV[0];
  const Section = SECTIONS[active];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="page-rules max-w-[1120px] w-[calc(100%-56px)] h-[min(760px,88vh)] p-0 gap-0 overflow-hidden"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">页签规则手册</DialogTitle>
        <nav className="pr-nav">
          <div className="pr-brand">页签规则手册</div>
          {NAV.map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={id === active ? 'on' : ''}
              onClick={() => setActive(id)}
            >
              <Icon aria-hidden />
              {title}
            </button>
          ))}
        </nav>
        <div className="pr-main">
          <div className="pr-bar">
            <span className="pr-h">{current.title}</span>
            <span className="pr-bar-sp" />
            <DialogClose className="pr-x" aria-label="关闭 (Esc)" title="关闭 (Esc)">
              <X aria-hidden />
            </DialogClose>
          </div>
          <div className="pr-body">
            <div className="pr-sec">
              <Section />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
