# Craft World Auto Bot

Bot tự động cho [Craft World](https://craft-world.gg) — chạy toàn bộ chuỗi sản xuất 6 tầng, tự làm mới token, tự bám phiên bản game, và tự bấm hộ hai loại boost x2.

Bot gọi thẳng HTTP API của game. Không điều khiển trình duyệt, không Selenium, không cần mở game. Chạy được 24/7 trên một VPS nhỏ nhất.

> Fork từ [vikitoshi/Craft-World-Auto-Bot](https://github.com/vikitoshi/Craft-World-Auto-Bot). Bản gốc chỉ chạy `index.js` với host preview cũ; bản này viết lại phần vòng lặp và thêm auth / boost / alert.

---

## Bot làm gì

**Chuỗi cung ứng.** Sáu tầng, mỗi tầng một timer độc lập:

```
earthMine → mud → clay → sand → copper → steel
```

Mỗi tầng **claim nguyên liệu của tầng trên** rồi **start các nhà máy của mình**. Ví dụ tầng `clay` sẽ `CLAIM_AREA` khu mud, sau đó `START_FACTORY` cả 3 lò clay.

**Tự làm mới token.** Firebase ID token chỉ sống 1 tiếng. Bot dùng refresh token (sống hàng tháng) tự lấy token mới ngay khi đang chạy. Không phải dán tay.

**Tự bám phiên bản game.** Server từ chối client cũ bằng `OUTDATED_VERSION`. Bot đọc `minAppVersion` trong chính lỗi đó, tự sửa `config.json`, rồi thử lại. Trong thực tế nó đã tự đi từ 1.15.1 lên 1.21.0 mà không cần ai đụng vào.

**Boost x2** — nếu tài khoản có gói skip quảng cáo, xem [Boost](#boost).

**Cảnh báo Telegram.** Gộp lỗi trong 5 giây thành một tin, chống trùng trong 10 phút.

---

## Cài đặt

Cần Node.js 18 trở lên.

```bash
git clone <repo-của-bạn>
cd Craft-World-Auto-Bot
npm install
```

Rồi tạo hai file cấu hình từ mẫu:

```bash
cp config.example.json config.json
cp auth.example.json  auth.json
```

### Bước 1 — điền `auth.json` (chìa khoá đăng nhập)

Hai file này bạn **tự điền bằng tay**, chép giá trị từ trình duyệt sang. Không có lệnh nào tự lấy hộ được, vì đây chính là thông tin phiên đăng nhập của bạn.

Mở [craft-world.gg](https://craft-world.gg), đăng nhập, bấm **F12** để mở DevTools:

1. Chọn tab **Application** (không phải Network)
2. Cột trái, mục **Storage** → mở **IndexedDB** → `firebaseLocalStorageDb` → `firebaseLocalStorage`
3. Bên phải hiện ra **một bản ghi duy nhất** — click vào nó để xem nội dung dạng cây
4. Tìm hai giá trị này:

| Trong trình duyệt | Chép vào `auth.json` |
|---|---|
| `apiKey` — chuỗi bắt đầu bằng `AIzaSy...` | `"apiKey"` |
| `stsTokenManager` → `refreshToken` — chuỗi rất dài, bắt đầu bằng `AMf-vB...` | `"refreshToken"` |

```json
{
  "apiKey": "AIzaSy...",
  "refreshToken": "AMf-vB..."
}
```

**Tại sao lại là `refreshToken` chứ không phải token đăng nhập?** Token đăng nhập (ID token) chỉ sống **1 tiếng** — chép nó vào thì cứ mỗi tiếng bot lại chết. Còn `refreshToken` sống **hàng tháng**, và [auth.js](auth.js) dùng nó để tự xin ID token mới trước khi cái cũ hết hạn.

Nghĩa là **bạn chỉ phải làm bước này một lần duy nhất**. Chỉ khi refreshToken bị thu hồi — bạn đăng xuất khỏi game trên mọi thiết bị, hoặc đổi mật khẩu — thì mới phải lấy lại. Dấu hiệu là bot báo `401` liên tục và không tự phục hồi.

Kiểm tra ngay sau khi điền:

```bash
node auth.js        # phải in ra "token refreshed"
```

Nếu lệnh này chạy được thì phần đăng nhập đã xong.

### Bước 2 — điền `config.json` (ID các nhà máy của bạn)

Mỗi tài khoản có bộ ID riêng, nên phải tự lấy:

1. Vẫn trong DevTools, chuyển sang tab **Network**
2. Gõ `ingest` vào ô lọc
3. Trong game, bấm chạy **một nhà máy bất kỳ**
4. Một request tên `ingest` hiện ra — click vào, xem tab **Payload**

Trong `payload` sẽ có `factoryId` (nhà máy), `mineId` (mỏ), hoặc `areaId` (khu vực thu hoạch). Lặp lại với từng công trình rồi điền vào các mảng `factories` và `areas` trong `config.json`.

Số lượng nhà máy bot chạy lấy từ **độ dài mảng** — thêm một ID là bot tự chạy thêm một lò, không phải sửa code.

### Chạy

```bash
node factory_loop.js
```

---

## Boost

Game có **hai** hệ boost khác nhau, bot dùng cả hai:

| | Boost mine | Boost toàn cục |
|---|---|---|
| Nút trong game | `▶x2` trên nhà máy đất | `+2h` góc dưới phải |
| Endpoint | `POST /graphql` — mutation `SkipAdWatch` | `POST /api/2/land-plots/boosters` |
| Tác dụng | Lần chạy kế tiếp của **một mine** ăn x2 | Giảm 50% thời gian **toàn bộ 5 land plot** |
| Bot gọi khi nào | Ngay trước mỗi `START_MINE` | Lúc khởi động, rồi mỗi 4 tiếng |
| Giới hạn | Quota theo ngày, reset lúc 23:59 | Đồng hồ tối đa 12 tiếng |

Cả hai nút này bình thường bắt xem quảng cáo. **Nếu tài khoản có gói skip quảng cáo** thì chỉ cần một cú click — và bot click hộ bạn.

### `boost.vip` — công tắc quan trọng nhất

```jsonc
"boost": {
  "vip": true,               // tài khoản có gói skip quảng cáo?
  "mineAdPlacement": "EARTH",
  "globalBoostEverySec": 14400,
  "globalBoostMaxHours": 12
}
```

**`vip: true`** — bot gọi cả hai boost. Thời gian sản xuất giảm còn một nửa, nên `durations` phải là bộ **đã chia đôi**.

**`vip: false`** — bot không gọi boost nào. Lúc này phải copy `durationsNoVip` đè lên `durations`, nếu không bot sẽ gọi sớm gấp đôi và log đầy `is not idle`.

```jsonc
"durations":      { "earthMine": 3600, "mud": 595,  ... }   // dùng khi vip: true
"durationsNoVip": { "earthMine": 7200, "mud": 1190, ... }   // dùng khi vip: false
```

Hai bộ số này để sẵn trong config, đổi qua lại chỉ là copy một khối.

---

## Cấu hình

`factory_loop.js` đọc **toàn bộ** số lượng và thời gian từ `config.json`. Thêm một nhà máy hay đổi chu kỳ **không cần sửa code** — số lò lấy từ độ dài mảng, chu kỳ lấy từ `durations`.

| Khoá | Ý nghĩa |
|---|---|
| `appVersion` | Header `x-app-version`. Bot tự cập nhật khi game lên đời. |
| `factories` | ID nhà máy theo tầng. Độ dài mảng = số lò bot sẽ chạy. |
| `areas` | ID khu vực cho `CLAIM_AREA`. Không có khu steel — steel claim khu copper. |
| `durations` | Chu kỳ mỗi tầng, tính bằng giây. Bot cộng thêm 5–10% jitter ngẫu nhiên. |
| `boost` | Xem [Boost](#boost). |
| `telegram` | `botToken` từ @BotFather, `chatId` từ `getUpdates`. Để trống cả hai = tắt. |

---

## Các file

| File | Vai trò |
|---|---|
| `factory_loop.js` | Bot chính. Chạy cái này. |
| `auth.js` | Làm mới Firebase token. Chạy riêng để kiểm tra. |
| `notify.js` | Gửi cảnh báo Telegram, gộp và chống trùng. |
| `log_server.js` | Dashboard log realtime qua SSE. |
| `mine_loop.js` | Chỉ chạy mine. Có trước `factory_loop.js`, giữ lại để tham khảo. |
| `test_factory*.js` | Script thử một phát, dùng khi debug. |
| `index.js` | Bản gốc của repo upstream. Không dùng. |

---

## Chạy 24/7 với systemd

```ini
# /etc/systemd/system/craft-bot.service
[Unit]
Description=Craft World factory bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Craft-World-Auto-Bot
ExecStart=/usr/bin/node /home/ubuntu/Craft-World-Auto-Bot/factory_loop.js
Restart=always
RestartSec=30
StandardOutput=append:/home/ubuntu/Craft-World-Auto-Bot/factory_loop.log
StandardError=append:/home/ubuntu/Craft-World-Auto-Bot/factory_loop.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now craft-bot
journalctl -u craft-bot -f
```

Dashboard log (tuỳ chọn): đặt biến môi trường `LOG_TOKEN` rồi chạy `log_server.js`, mở `http://<ip>:8080/?key=<LOG_TOKEN>`.

---

## Đọc log

Mấy dòng này trông như lỗi nhưng **hoàn toàn bình thường**:

| Log | Nghĩa là |
|---|---|
| `is not idle` | Nhà máy đang sản xuất dở. Vòng sau sẽ start được. |
| `still running` | Mine chưa xong chu kỳ. Bình thường ngay sau khi claim. |
| `Not enough balance` | Chuỗi chưa đủ nguyên liệu. Sẽ hết khi các tầng trên chạy đủ. |
| `Nothing to claim` | Khu vực chưa tích được gì. |
| `boost not armed` | Hết quota boost hôm nay. Bot vẫn start bình thường, chỉ là không x2. |

Đáng lo thì chỉ có `401` (refresh token bị thu hồi) và lỗi mạng liên tục.

---

## Chi tiết API

Mọi hành động trong game đi qua một endpoint duy nhất:

```
POST https://craft-world.gg/api/1/user-actions/ingest
{ "data": [ { "id": "<uuidv7>", "actionType": "START_FACTORY",
              "payload": { "factoryId": "..." }, "time": <ms epoch> } ] }
```

Bốn thứ dễ sai, mỗi thứ đều tốn vài vòng thử-sai mới ra:

**`id` phải là UUIDv7.** Gửi v4 nhận về `Invalid user action format`. Đây là lý do repo cần `uuid@11+` chứ không phải `uuid@9` của bản gốc.

**`time` phải tăng nghiêm ngặt** trên mỗi tài khoản. Sáu timer chạy song song sẽ đá nhau, nên mọi request đi qua một mutex chung và mỗi cái được đóng dấu `max(now, lastTime + 1)`.

**Không có `CLAIM_FACTORY`.** Nhà máy chỉ được `START_FACTORY`; sản phẩm thu bằng `CLAIM_AREA` trên khu vực. Chỉ mine mới có động từ claim riêng là `CLAIM_MINE`.

**`CLAIM_AREA` bắt buộc có `amountToClaim`**, và phải gửi số thật lớn. Gửi `1` thì server vẫn trả OK nhưng chỉ thu đúng 1 đơn vị — cả chuỗi sẽ chết đói từ tầng 3 trở xuống mà không báo lỗi gì. Bot gửi 1 tỷ, server tự kẹp về "thu hết".

Ngoài ra, `factoryInventory` trong response **chỉ liệt kê nhà máy đang rảnh**. Nhà máy đang chạy biến mất khỏi danh sách.

---

## Bảo mật

`auth.json`, `config.json`, `token.txt` đều nằm trong `.gitignore` — chúng chứa refresh token Firebase (quyền truy cập toàn bộ tài khoản, sống hàng tháng) và Telegram bot token.

**Trước khi push lần đầu**, kiểm tra remote đang trỏ về repo của chính bạn:

```bash
git remote -v
```

Nếu bạn clone từ repo khác, `origin` vẫn trỏ về đó. Đổi bằng `git remote set-url origin <repo-của-bạn>`.

Nếu lỡ commit nhầm: thu hồi refresh token bằng cách đăng xuất khỏi game trên mọi thiết bị, và `/revoke` bot Telegram qua @BotFather.

---

## Giấy phép

MIT — như repo gốc.
