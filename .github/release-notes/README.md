# Bilingual release highlights / 双语发行亮点

Every product tag `v<version>` requires a committed `.github/release-notes/<version>.md` file. The release workflow fails before packaging if that exact file is absent.

每个产品标签 `v<version>` 都必须提前提交 `.github/release-notes/<version>.md`。若精确版本文件不存在，发行工作流会在打包前明确失败。

Write the English highlights first and the Chinese highlights second. Keep both sections in the same file so a GitHub Release cannot publish only one language. The workflow appends GitHub's generated pull-request list after this file.

先写英文亮点，再写中文亮点。两种语言保存在同一文件中，避免 GitHub Release 只发布其中一种；工作流会把 GitHub 自动生成的拉取请求列表追加在本文件之后。

```markdown
## Highlights

- Describe a user-visible change.

## 发行亮点

- 描述一项用户可见的变化。
```

The current macOS DMGs are ad-hoc signed rather than Developer ID signed and notarized. State that limitation in every version file until the distribution posture changes.

当前 macOS DMG 使用 ad-hoc 签名，尚未采用 Developer ID 签名和公证；在分发方式改变前，每个版本文件都必须说明这一限制。
