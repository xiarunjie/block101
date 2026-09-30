# 
<p align="center">
<img src="https://user-images.githubusercontent.com/91664985/138204882-91148e1a-36af-4ac4-a395-f17233b6cbb8.png" width="200" height="200" />
</p>

<h1 align="center">AD101</h1>

AD101是一款Safari浏览器扩展，完全基于iOS 15/iPadOS 15开发，能够拦截恶意的网页内app应用跳转，去除诱导广告，以此来进一步保护用户在浏览网页时的隐私和阻止广告追踪。除此之外，对于许多网页为了恶意跳转app而隐藏长文内容的行为，AD101也会将其拦截并且自动展开长文内容，提高用户网页的体验。

> **主要功能**：防 App 跳转 · 去广告（内置站点规则 + AdGuard 式元素选取器 + 规则订阅）· 自动展开全文 · 拦截统计仪表盘
#
# 版本兼容性
### v1.2.0（2026-09-26）
- **新增设置面板（popup）**：点击工具栏扩展图标即可查看今日拦截计数与最近拦截记录，并可单独控制总开关、站点开关与元素选取器。
- **新增元素选取器**（AdGuard 式 Block element）：在 popup 中启动后，悬停高亮页面任意元素、点选即屏蔽，规则写入本地存储并即时生效，支持逐站点自定义。
- **新增原生规则通道**：`rules.json` 经 Safari 原生通道下发，支持内置垃圾站点名单与广告规则订阅（AWAvenue）热更新。
- **新增拦截统计**：扩展侧统计拦截事件，配套 App 提供 SwiftUI 拦截仪表盘与系统信息页。
- **站点规则增强**：知乎新增「强制登录 / 使用 App 阅读」弹窗拦截。
- **健壮性修复**：打通远程规则读取链路（此前 storage 中的规则从未被 content 读取）；命令分发加白名单；站点正则容错与编译缓存；提示条幂等渲染。

### v1.1.0（2026-09-25）
- 已升级至 **Manifest V3**：background 改为 Service Worker，脚本注入改用 `chrome.scripting` API。
- 兼容 Safari 16.4+（iOS/iPadOS 15.4+），含 iOS 27 / Safari 27。请使用新版 Xcode 构建运行。
- 注入方式说明：MV3 禁止注入任意代码字符串，iframe 路径变量改由 `set_frame_path` 命令以 func+args 写入。

# 使用手册
### 安装和运行：
1：在Xcode中创建Safari Extension App项目。  
2：创建成功后，替换SafarWebExtension所在扩展文件夹下的Resources文件夹为此仓库Resources文件夹，  
3：运行项目  
  在Safari中打开扩展查看。


### 代码目录：
#### 1：Resources/jumpapp 文件夹为防App跳转目录：  
此目录下可新增或修改防止网站跳转App代码  
每个App跳转单独文件夹，在对应文件夹下创建编写js文件  
在content.js中判断域名等执行对应的js  

#### 2：Resources/domain 文件夹为目前匹配站点的展开全文和去除广告目录：  
此目录下每个文件夹以用来匹配的站点域名为名称如xx.xx.com，包含call.js和read.js和网站中文名.md。  
call.js ：去除当前站点广告代码  
read.js 阅读当前站点时的展开全文代码  
domain/domain.js：目前匹配站点清单及url地址匹配规则，key与具体站点文件夹名字对应。  
新增修改代码时，根据需要可能需同步修改background.js和content.js或插件配置代码。  

#### 3：Resources/popup.html / popup.js / popup.css  
扩展设置面板（工具栏图标弹出）：总开关与站点开关、今日拦截计数、最近拦截记录、元素选取器入口。  

#### 4：Resources/picker.js  
AdGuard 式元素选取器。由 popup 通过 `scripting.executeScript({ files: ['picker.js'] })` 注入页面，  
悬停高亮 → 点选 → 确认后规则写入 `ad101.user_rules` 并即时生效，支持连续选取与逐站点生效。  

#### 5：Resources/rules.json  
原生通道下发的规则数据（内置垃圾站点名单、广告规则订阅清单等），由 App 侧原生 handler 读取后经 `get_rules` 命令返回给扩展。  
# 
# 社区
  如果你有好的意见或建议，欢迎给我们提 Issues 
#
# 参与贡献
   ### 1：Fork仓库  
      点击 Fork 按钮，将需要参与的项目仓库 fork 到自己的 Github 中。  
   ### 2：Clone 已经fork的项目  
     在自己的 github 中，找到 fork 下来的项目，git clone 到本地。  
   ### 3：贡献代码
    将 fork 源仓库连接到本地仓库， commit 信息提交，请描述提交的原因和功能。  
#
  # License
   Copyright (c) 2021-2028 UU Momentum Network Technology Co., Ltd., All rights reserved.

Licensed under The GNU General Public License version 2 (GPLv2) (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at

https://www.gnu.org/licenses/gpl-2.0.html

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 
 
