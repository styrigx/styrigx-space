# 浏览器页书签图标（入库）

`layouts/partials/fav-icon.html` 优先读这里的图标，文件名 = 域名把 `.` 换成 `-`，扩展名 `.png` 或 `.jpg`
（例：`www.aliyun.com` → `www-aliyun-com.png`）。构建时统一转成 64px webp。

为什么入库：以前每次构建都从 Google 图标服务现下载，同一个站点有时返回不同的图，
浏览器页的视觉回归截图因此偶发失败。

新加书签：从 `https://www.google.com/s2/favicons?domain=<域名>&sz=64` 下载存进来；
没入库的仍会在构建时现下载（兜底），但截图可能不稳。
