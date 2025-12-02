# 小黑盒自动评论脚本

## 项目介绍
这是一个基于 Puppeteer 的自动化脚本，用于在小黑盒平台上自动登录并对帖子进行评论。脚本支持定时执行，可以根据配置在指定时间点自动运行。

## 功能特性
- 🤖 自动登录小黑盒账号
- 💬 随机从评论库中选择评论内容
- ⏰ 支持配置多个定时任务（默认每天早8点和晚6点）
- 🚀 支持本地运行和 GitHub Actions 部署
- 🛡️ 适配无头浏览器环境，优化 CI 执行
- 🔍 自动处理弹窗和页面交互

## 安装指南

### 前提条件
- Node.js 18.0.0 或更高版本
- npm 或 yarn 包管理器

### 安装步骤
1. 克隆项目到本地
```bash
git clone https://github.com/linmuqiang/xiaoheihe-auto-comment.git
cd xiaoheihe-auto-comment
```

2. 安装依赖
```bash
npm install
# 或
yarn install
```

## 使用方法

### 本地运行
1. 修改 `xiaoheihe-auto-comment.js` 中的配置参数（可选）
   - 账号密码（本地运行时硬编码，也可通过环境变量配置）
   - 定时任务时间
   - 评论内容库
   - DOM 选择器（一般不需要修改）

2. 启动脚本
```bash
npm start
# 或
yarn start
```

### GitHub Actions 部署
1. Fork 本仓库到你的 GitHub 账号

2. 在仓库 Settings > Secrets and variables > Actions 中添加以下环境变量：
   - `XHH_USERNAME`：小黑盒账号
   - `XHH_PASSWORD`：小黑盒密码

3. GitHub Actions 会根据 `.github/workflows/auto-comment.yml` 中的配置自动执行

## 配置说明

### 核心配置参数
```javascript
const CONFIG = {
  // 用户账号密码
  username: process.env.XHH_USERNAME || "默认账号",
  password: process.env.XHH_PASSWORD || "默认密码",
  // 定时任务配置（cron表达式）
  scheduleConfig: [
    "0 8 * * *", // 每天早上8点
    "0 18 * * *" // 每天晚上6点
  ],
  // 评论内容库
  commentLib: [
    "哈哈，这个内容太有意思了！",
    "支持一下，分析得很到位～",
    // 更多评论内容...
  ],
  // 浏览器配置
  browserOptions: {
    // Puppeteer 配置参数
  }
};
```

### 修改评论内容
你可以在 `commentLib` 数组中添加或修改评论内容，脚本会随机选择一条进行评论。

### 修改执行时间
使用 cron 表达式设置定时任务，格式为：`分钟 小时 日 月 星期`

## GitHub Actions 配置
仓库中的 `.github/workflows/auto-comment.yml` 文件定义了 GitHub Actions 的执行规则：
- 每天按照配置的时间自动运行
- 使用安全的环境变量存储账号信息
- 支持手动触发工作流

## 注意事项
1. 使用脚本时请遵守小黑盒平台的用户协议和使用条款
2. 过于频繁的评论可能会触发平台的反爬虫机制
3. 建议适量配置评论内容，避免重复内容过多
4. 定期检查 DOM 选择器是否有效，平台更新可能导致选择器失效

## 技术栈
- Node.js
- Puppeteer - 浏览器自动化
- node-schedule - 定时任务
- fs-extra - 文件操作增强

## 许可证
本项目采用 MIT 许可证 - 详情请查看 LICENSE 文件

## 免责声明
本脚本仅供学习和研究使用，请勿用于任何违反平台规则或法律法规的行为。使用本脚本产生的任何后果由使用者自行承担。