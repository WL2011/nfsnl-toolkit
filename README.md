# NFSNL 工具箱 · 网页版

由「NFSNL」微信小程序移植而来的桌面网页版。原小程序的**页面逻辑和数据原样复用**，界面换成了适合电脑的布局和现代简约风格。

只保留了这几个页面（在 `tools/build.js` 的 `KEEP` 里配置）：

| 页面 | 路由 | 界面 |
|---|---|---|
| 赛车 | `pages/index/index` | 重新设计（`views/pages/index.html`） |
| 地下 | `pages/underground/underground` | 重新设计（`views/pages/underground.html`） |
| 活动 | `pages/activity/activity` | 重新设计（`views/pages/activity.html`） |
| 赛车详情 | `pages/car/car` | 重新设计（`views/pages/car.html`） |
| 搜索 | `pages/search/search` | 重新设计（`views/pages/search.html`），搜索逻辑升级在 `assets/search.js` |
| 特殊赛信息 | `pages/se/se` | 重新设计（`views/pages/se.html`） |
| 特殊赛零件计算器「肝它」 | `pages/separtsnotes/separtsnotes` | 重新设计（`views/pages/separtsnotes.html`） |
| 赛车对比（地下赛 VS） | `pages/compare/compare` | 重新设计（`views/pages/compare.html`） |

其余页面（零件、信息、各种一览、我的车库统计、数据导入/导出等）已移除；原小程序里指向它们的入口会提示"该功能已移除"。想恢复某个页面，把它加回 `KEEP` 再重新构建即可。

## 运行

纯静态网站，不需要安装依赖。在本目录启动任意静态服务器即可：

```bash
python3 -m http.server 5173
```

然后打开 http://localhost:5173 。

需要联网：Vue 从 cdnjs 加载，车辆图片/品牌标志从原来的阿里云 OSS 加载。

## 目录结构

| 路径 | 说明 |
|---|---|
| `index.html` | 入口 |
| `assets/runtime.js` | 运行时：模块加载器、`wx.*` 接口兼容层、`Page()/App()`、路由与页面栈、选择器/轮播组件 |
| `assets/search.js` | 搜索升级：多关键词排序匹配、别称/容错、筛选排序、最近搜索、键盘与 / 、Ctrl/⌘+K 快捷键 |
| `assets/shell.js` | 桌面外壳：左侧导航、顶栏、弹窗/提示/看图 |
| `assets/theme.css` | 设计变量（颜色、圆角、深色模式）+ 外壳样式 |
| `assets/overrides.css` | 把原页面样式现代化的覆盖层 |
| `assets/views.css` | 手写新视图的样式 |
| `views/` | **手写的新页面/模板**（放在这里的会替换原模板） |
| `generated/` | 构建产物，不要手改 |
| `source/unpacked/` | 解包出来的原小程序 |
| `source/wxml/` | 反编译出来的可读 WXML（仅供参考） |
| `tools/build.js` | 构建脚本 |
| `tools/wxdec.py` | 解密 PC/Mac 微信缓存里的 `.wxapkg` |

## 在线访问

部署在 GitHub Pages：https://wl2011.github.io/nfsnl-toolkit/

## 修改与重新构建

> 注意：`source/`（解包的原小程序）没有放进仓库，只保存在本地。重新构建需要在有 `source/unpacked` 的电脑上进行。


改了 `views/` 或 `tools/build.js` 之后需要重新生成：

```bash
node --expose-internals tools/build.js
```

（`--expose-internals` 用来调用 Node 自带的 JS 解析器，不需要额外安装。）

- **重做某个页面**：在 `views/pages/<页面名>.html` 写 Vue 模板（例如 `views/pages/index.html`），重新构建即可替换原页面。模板里直接用原页面的数据字段，事件用 `__e($event, '方法名', {数据集}, '标签', 'id')` 调用原页面方法，跳转用 `__nav($event, url, 'navigate')`。
- **共用模板**：`views/templates/<模板名>.html`（例如车辆卡片 `caritem`），新页面里用 `<include-template name="caritem" />` 引入。
- 没有手写视图的页面会自动使用"原模板 + 新样式"。

## 和小程序的差异

- 数据保存在浏览器 localStorage（前缀 `nfsnl:`），与手机上的小程序数据互不相通（数据导入/导出页已移除）。
- 随机弹出的"游戏语录"彩蛋已关闭（它会跳到已移除的信息页）。
- 外观设置移到了左下角：浅色 / 深色 / 跟随系统，以及主题色。原来的"夜间自动（23 点到 7 点）"改成了跟随系统。
- 长按操作在电脑上对应**右键**（例如右键车名复制）。
- 分享、客服、订阅消息等微信专属功能不可用。
