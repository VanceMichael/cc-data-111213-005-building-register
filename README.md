# 建筑模型构件资料的关系化领取

building-register 用于合作资料的本地查看和来源保存，并从 IFC4 移交模型领取设备台账。资料对象按内容摘要保存，每次领取保留单独回执；台账和两次移交的差异都保留到原始 STEP 语句的来源。

## 运行环境

使用 Node.js 22。依赖已锁定；首次准备执行 `npm ci --ignore-scripts`，正式运行无需下载资料或软件。全部样例使用合成数据与本机来源，不连接生产系统。

```bash
npm run check
npm test
npm run demo
```

`npm run demo` 读取本地合成模型，打印设备台账和两组两次移交的差异（A→B、A→C），并在临时目录归档、重新核验摘要，退出时清理临时内容。A→B 演示新增设备和资料变化，以及两条不能判成拆除的消失；A→C 演示关系完好时的真正拆除。正常运行不下载资料或软件。

## 资料操作

```bash
npm start -- inspect fixtures/plant.ifc
npm start -- entity fixtures/plant.ifc 11
npm start -- ledger fixtures/handover-a.ifc
npm start -- index fixtures/handover-a.ifc
npm start -- rows fixtures/handover-a.ifc 4AAAAAAAAAAAAAAAAAAAAA
npm start -- diff fixtures/handover-a.ifc fixtures/handover-b.ifc
npm start -- capture fixtures/plant.ifc .local/archive
npm start -- list .local/archive
```

`inspect` 保留原有查看入口，按 STEP 编号列出实体参数。`entity` 额外给出该实体的前后引用和文件行号。`capture` 只表示来源字节已保存，不声称领域流程已自动完成。`scripts/create-fixtures.js` 重建 `plant.ifc`；`handover-*.ifc` 是手工维护的合成移交资料，测试直接读取已提交的文件。

## 设备台账

`ledger` 读取一次模型并建立四个索引：类型分配、属性关系、空间包含与分解、单位分配。每条设备记录同时保留：

- **身份**：`GlobalId` 是跨交付的业务标识；`stepId` 只是本文件内的位置。同名设备、重复 `GlobalId` 显式列出，不据此合并。
- **位置**：直接的 `IfcRelContainedInSpatialStructure` 和经 `IfcRelAggregates` / `IfcRelNests` 继承的容器都会列出，每一跳都带关系编号；无归属和多容器分别标记。
- **类型**：全部类型对象及其属性集、显式 `IfcRelOverridesProperties` 覆盖。多条类型关系不取舍，列入 `issues`。
- **属性来源**：类型对象属性集和实例属性集各自成行。属性名相同但来源不同的值不合并，列入 `conflicts`，并给出双方属性步骤和行号。
- **单位**：声明的度量类型 → 属性自带单位 → 项目单位分配。值保留声明类型；嵌套列表和枚举不压成字符串。每个数值给出原始值、所用单位、换算公式和 SI 基准值。
- **完整性**：坏引用、缺失属性、缺失单位等逐条列出，设备仍然保留。

每个字段的 `source` 包含属性、属性集、关系和类型对象的 `stepId` 与 `stepLine`，可以直接回到原 STEP 语句。`index` 只输出设备级索引（身份、位置、类型、冲突与缺口计数），供先选设备再展开；`rows` 把台账展开成逐行记录并带来源行号。二者都避免为查找一台设备而把整份台账放进上下文。

## 两次移交比较

`diff` 以 `GlobalId` 配对设备，报告 `added`、`removed`、`changed`，其余放入 `uncertain`：

- 新增要求较早交付的实体清单完整且身份唯一。
- 消失只有在较晚交付的实体清单完整、身份唯一，并且没有任何损坏关系或该设备自身未解析的依赖可能掩盖它时，才判为拆除；否则给出无法判定的原因。
- 资料变化若涉及未解析的属性或单位，进入 `uncertain.changed` 并附上双方的具体缺口。
- 数值比较使用换算后的 SI 值，`1200 mm` 与 `1.2 m` 视为同一物理量；显示仍保留原始文本和公式。

## 目录约定

- `src/step.js`：STEP 交换结构读取，保留值类型、枚举、引用和文件行号。
- `src/ifc.js`：IFC4 实体与关系索引。
- `src/ifc-units.js`：项目单位、换算单位和派生单位的解释链。
- `src/ledger.js`：设备台账与两次移交差异。
- `src/domain.js`：原有资料查看入口，以及单实体的前后引用。
- `src/archive.js`：内容对象、来源回执与完整性检查。
- `fixtures/`：本地合成资料。
- `test/`：行为验证，使用独立临时目录。

## 规模与索引

台账构建对每份模型只做一次全量扫描，随后所有查询都走 `byId`、`byType` 和关系反向索引；单个设备只访问自己的关系邻域，不会为每台设备重新解析文件。损坏的引用在建立索引时记录一次，供台账和差异共用。

## Linux 环境

`Dockerfile` 使用 Node.js 22 镜像；浏览器项目使用包含 Chromium 的运行镜像。可执行 `docker build -t building-register:local .` 后运行 `docker run --rm --network none building-register:local npm test`。测试中的 HTTP、MQTT 和门户都仅绑定回环地址；不需要第二个容器。构建阶段准备依赖，运行时不安装依赖。
