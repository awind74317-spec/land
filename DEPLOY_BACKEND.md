# 公開後端部署說明（Render）

本 repo 保持 Private，核心解析邏輯留在後端。公開前端位於 `awind74317-spec/land-web`。

## 後端入口

- 健康檢查：`GET /health`
- PDF 解析：`POST /api/parse`
- 上傳欄位名稱：`file`
- 最大檔案：20MB
- 最大頁數：200頁

## Render 部署

1. 登入 Render。
2. New → Blueprint。
3. 連接 GitHub 帳號並授權讀取 Private repo `awind74317-spec/land`。
4. 選擇本 repo；Render 會讀取 `render.yaml`。
5. 建立服務後等待 Build / Deploy 完成。
6. 開啟 `https://<你的服務>.onrender.com/health`，看到 `{ "ok": true, "status": "healthy" }` 代表後端已啟動。
7. 將 Render 根網址（不要加 `/api/parse`）填入 `land-web` 的「後端 API 網址」。

例如：

```text
https://land-api-xxxx.onrender.com
```

前端會呼叫：

```text
POST https://land-api-xxxx.onrender.com/api/parse
```

## 隱私

目前 `/api/parse` 直接將上傳 PDF 讀入記憶體並處理，不主動將原始 PDF 寫入磁碟或資料庫。Render / 反向代理等平台層仍可能保留一般連線日誌，因此正式對外前仍應放置隱私說明。

## 目前能力

目前公開後端版本已完成：

- HTTPS 平台可部署的 FastAPI API
- PDF 檔案與大小檢查
- PDF 頁數限制
- PyMuPDF 文字層提取
- 基礎地政欄位辨識
- 權利人區塊提取
- 風險關鍵字辨識
- CORS 僅預設允許 `https://awind74317-spec.github.io`
- 不保存原始 PDF

## 尚未移植

原本 Windows 本機版的完整專有解析與 OCR 尚未全部搬入本後端，包括：

- Windows OCR / `ocr_index_rows.ps1`
- 圖片型異動索引完整辨識
- 局部 OCR 修復
- 完整交叉核對
- 原 `index.html` 內所有成熟欄位解析規則與歷程合併邏輯

目前版本是「可部署、可連線、可處理文字型 PDF」的後端基線；上述能力應逐步伺服器化後再視為與本機版功能等價。
