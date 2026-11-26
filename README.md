# DroidLab Phone Emulator

Full-screen HTML, CSS, and JavaScript Android phone emulator connected live to Firebase Realtime Database (`uid/status`, `uid/calllog`, `uid/messages`, `uid/contacts`, and `uid/apps`).

## Features
- **Device UID Directory**: Lists all device UIDs from Firebase Realtime Database and opens the full-screen phone shell on click.
- **Phone & Call Log**: Incoming/outgoing/missed call history and interactive dialer.
- **Messages (SMS)**: Threaded inbox, unread tracking, reply composer, and new SMS form.
- **Contacts**: Searchable directory with call, SMS, favorite, add, and delete actions.
- **App List**: Installed apps list with search, category filter, enable/disable, and APK install/uninstall.
- **System & Battery**: Live device name, battery level, charging state, Wi-Fi/Bluetooth toggles, storage, and RAM stats.

## Deploy Directly from `main` / `/ (root)` on GitHub Pages
1. Push this repository to GitHub (`main` branch).
2. In your GitHub repository, open **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Select branch **`main`** and folder **`/ (root)`**, then click **Save**.
5. Your app will be served directly from root without needing any build step.

## Local Development (Optional)
```bash
npm install
npm run dev
```
