// FilmPosterApp C++ v1.0 — MyFilms Poster + Background (Win32, khong can Python)
// ============================================================================
// App Win32 thuan, 1 file .cpp duy nhat, khong can thu vien ngoai.
// - Giao dien co nut: Push Poster | Push Background | Push Ca Hai | Xem truoc
// - Up anh len Google Drive + ghi link vao Google Sheet (cot E poster, cot G
//   background), giong het ban Python, dat ten anh theo "phim X".
// - Dang nhap Google bang OAuth2 (mo trinh duyet, nghe localhost lay code),
//   token luu o token.json, lan sau khong hoi nua.
// - Build ra .exe bang MSVC (build.bat) hoac MinGW (build_mingw.bat).
//   Link SUBSYSTEM:WINDOWS nen mo len KHONG hien cua so cmd.
// - CHUA duoc bien dich / chay thu tren Windows o day (may tao chay Linux),
//   may build tren PC Windows theo HUONG-DAN-CPP.txt roi bao lai neu loi.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <shlobj.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <map>
#include <fstream>
#include <sstream>
#include <functional>
#include <thread>
#include <ctime>
#include <cctype>
#include <cstring>
#include <cstdlib>
#include <memory>
#include <tuple>
#include <algorithm>
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "shell32.lib")

// ---------- Tien ich chuoi ----------
static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}
static std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}
static std::string UrlEncode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
            || c == '-' || c == '_' || c == '.' || c == '~') out += (char)c;
        else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
    }
    return out;
}
static std::string UrlDecode(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size(); i++) {
        if (s[i] == '%' && i + 2 < s.size()) {
            auto hv = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                return 0;
            };
            out += (char)(hv(s[i + 1]) * 16 + hv(s[i + 2]));
            i += 2;
        } else if (s[i] == '+') out += ' ';
        else out += s[i];
    }
    return out;
}
static std::string ToLowerStr(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
    return s;
}
static std::string TrimStr(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}
static bool ReadFileBytes(const std::wstring& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}
static bool WriteFileText(const std::wstring& path, const std::string& data) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f << data;
    return true;
}
static std::wstring ExeDir() {
    wchar_t buf[MAX_PATH] = { 0 };
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring p(buf);
    size_t pos = p.find_last_of(L"\\/");
    return pos == std::wstring::npos ? L"." : p.substr(0, pos);
}
static void AppendUtf8(std::string& out, unsigned int cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
    else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
}

// ---------- JSON toi thieu (du de doc tra loi cua Google) ----------
struct Json {
    enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
    bool b = false;
    double num = 0;
    std::string str;
    std::vector<Json> arr;
    std::vector<std::pair<std::string, Json>> obj;
    const Json* find(const std::string& key) const {
        if (type != Obj) return nullptr;
        for (auto& kv : obj) if (kv.first == key) return &kv.second;
        return nullptr;
    }
    std::string asStr(const std::string& def = "") const { return type == Str ? str : def; }
};
struct JsonParser {
    const char* p;
    explicit JsonParser(const std::string& s) : p(s.c_str()) {}
    void ws() { while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++; }
    Json parse() { ws(); Json v = value(); ws(); return v; }
    Json value() {
        ws();
        if (*p == '{') return object();
        if (*p == '[') return array();
        if (*p == '"') { Json v; v.type = Json::Str; v.str = str(); return v; }
        if (strncmp(p, "true", 4) == 0) { p += 4; Json v; v.type = Json::Bool; v.b = true; return v; }
        if (strncmp(p, "false", 5) == 0) { p += 5; Json v; v.type = Json::Bool; v.b = false; return v; }
        if (strncmp(p, "null", 4) == 0) { p += 4; return Json(); }
        char* end = nullptr;
        double d = strtod(p, &end);
        p = end;
        Json v; v.type = Json::Num; v.num = d; return v;
    }
    std::string str() {
        std::string out;
        p++; // "
        while (*p && *p != '"') {
            if (*p == '\\') {
                p++;
                char e = *p++;
                if (e == 'n') out += '\n';
                else if (e == 't') out += '\t';
                else if (e == 'r') out += '\r';
                else if (e == 'u') {
                    unsigned int cp = 0;
                    for (int i = 0; i < 4 && isxdigit((unsigned char)*p); i++) {
                        char c = *p++;
                        cp = cp * 16 + (c <= '9' ? c - '0' : (c <= 'F' ? c - 'A' + 10 : c - 'a' + 10));
                    }
                    if (cp >= 0xD800 && cp <= 0xDBFF && p[0] == '\\' && p[1] == 'u') {
                        p += 2;
                        unsigned int lo = 0;
                        for (int i = 0; i < 4 && isxdigit((unsigned char)*p); i++) {
                            char c = *p++;
                            lo = lo * 16 + (c <= '9' ? c - '0' : (c <= 'F' ? c - 'A' + 10 : c - 'a' + 10));
                        }
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    AppendUtf8(out, cp);
                }
                else out += e;
            } else out += *p++;
        }
        if (*p == '"') p++;
        return out;
    }
    Json array() {
        Json v; v.type = Json::Arr;
        p++; ws();
        if (*p == ']') { p++; return v; }
        while (true) {
            v.arr.push_back(value());
            ws();
            if (*p == ',') { p++; continue; }
            if (*p == ']') { p++; break; }
            break;
        }
        return v;
    }
    Json object() {
        Json v; v.type = Json::Obj;
        p++; ws();
        if (*p == '}') { p++; return v; }
        while (true) {
            ws();
            std::string key = str();
            ws();
            if (*p == ':') p++;
            Json val = value();
            v.obj.push_back({ key, val });
            ws();
            if (*p == ',') { p++; continue; }
            if (*p == '}') { p++; break; }
            break;
        }
        return v;
    }
};
static std::string JsonEscape(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out += c;
    }
    return out;
}

// ---------- HTTP bang WinHTTP ----------
struct HttpResult { long status = 0; std::string body; std::string error; };
static HttpResult HttpRequest(const std::string& method, const std::string& host,
                              const std::string& path, const std::string& body,
                              const std::string& contentType,
                              const std::string& authBearer) {
    HttpResult r;
    HINTERNET hSession = WinHttpOpen(L"FilmPosterApp/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                     WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) { r.error = "WinHttpOpen that bai"; return r; }
    DWORD timeout = 60000;
    WinHttpSetTimeouts(hSession, timeout, timeout, timeout, timeout);
    HINTERNET hConnect = WinHttpConnect(hSession, Utf8ToWide(host).c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); r.error = "WinHttpConnect that bai"; return r; }
    HINTERNET hReq = WinHttpOpenRequest(hConnect, Utf8ToWide(method).c_str(), Utf8ToWide(path).c_str(),
                                        nullptr, WINHTTP_NO_REFERER,
                                        WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
    if (!hReq) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); r.error = "WinHttpOpenRequest that bai"; return r; }
    std::wstring headers;
    if (!authBearer.empty()) headers += L"Authorization: Bearer " + Utf8ToWide(authBearer) + L"\r\n";
    if (!contentType.empty()) headers += L"Content-Type: " + Utf8ToWide(contentType) + L"\r\n";
    if (!headers.empty()) WinHttpAddRequestHeaders(hReq, headers.c_str(), (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);
    BOOL ok = WinHttpSendRequest(hReq, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                 body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(),
                                 (DWORD)body.size(), (DWORD)body.size(), 0);
    if (!ok) { r.error = "WinHttpSendRequest that bai"; }
    else if (!WinHttpReceiveResponse(hReq, nullptr)) { r.error = "WinHttpReceiveResponse that bai"; }
    else {
        DWORD status = 0, sz = sizeof(status);
        WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX);
        r.status = (long)status;
        while (true) {
            DWORD avail = 0;
            if (!WinHttpQueryDataAvailable(hReq, &avail) || avail == 0) break;
            std::string chunk(avail, 0);
            DWORD read = 0;
            if (!WinHttpReadData(hReq, &chunk[0], avail, &read)) break;
            r.body.append(chunk.data(), read);
        }
    }
    WinHttpCloseHandle(hReq);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return r;
}

// ---------- Google API (OAuth2 + Drive + Sheets) ----------
struct Config {
    std::string spreadsheetId;
    std::string driveFolderId;
    std::string sheetName;
    std::string postersDir = "posters";
    std::string backgroundsDir = "backgrounds";
};
static std::string ReadTextFile(const std::wstring& path) {
    std::string data;
    if (!ReadFileBytes(path, data)) return "";
    return data;
}
static Config LoadConfig(const std::wstring& path) {
    Config cfg;
    Json j = JsonParser(ReadTextFile(path)).parse();
    if (const Json* v = j.find("spreadsheet_id")) cfg.spreadsheetId = v->asStr();
    if (const Json* v = j.find("drive_folder_id")) cfg.driveFolderId = v->asStr();
    if (const Json* v = j.find("sheet_name")) cfg.sheetName = v->asStr();
    if (const Json* v = j.find("posters_dir")) cfg.postersDir = v->asStr("posters");
    if (const Json* v = j.find("backgrounds_dir")) cfg.backgroundsDir = v->asStr("backgrounds");
    return cfg;
}
static void SaveConfig(const std::wstring& path, const Config& cfg) {
    std::string s = "{\n  \"spreadsheet_id\": \"" + JsonEscape(cfg.spreadsheetId) + "\",\n"
        "  \"drive_folder_id\": \"" + JsonEscape(cfg.driveFolderId) + "\",\n"
        "  \"sheet_name\": \"" + JsonEscape(cfg.sheetName) + "\",\n"
        "  \"posters_dir\": \"" + JsonEscape(cfg.postersDir) + "\",\n"
        "  \"backgrounds_dir\": \"" + JsonEscape(cfg.backgroundsDir) + "\"\n}\n";
    WriteFileText(path, s);
}

struct GoogleApi {
    std::string clientId, clientSecret, authUri, tokenUri;
    std::string accessToken, refreshToken;
    time_t expiresAt = 0;
    std::function<void(const std::string&)> log;
    std::wstring baseDir;

    bool loadCredentials() {
        Json j = JsonParser(ReadTextFile(baseDir + L"\\credentials.json")).parse();
        const Json* inst = j.find("installed");
        if (!inst) return false;
        if (const Json* v = inst->find("client_id")) clientId = v->asStr();
        if (const Json* v = inst->find("client_secret")) clientSecret = v->asStr();
        if (const Json* v = inst->find("auth_uri")) authUri = v->asStr("https://accounts.google.com/o/oauth2/auth");
        if (const Json* v = inst->find("token_uri")) tokenUri = v->asStr("https://oauth2.googleapis.com/token");
        return !clientId.empty();
    }
    bool loadToken() {
        Json j = JsonParser(ReadTextFile(baseDir + L"\\token.json")).parse();
        if (const Json* v = j.find("access_token")) accessToken = v->asStr();
        if (const Json* v = j.find("refresh_token")) refreshToken = v->asStr();
        if (const Json* v = j.find("expires_at")) expiresAt = (time_t)v->num;
        return !accessToken.empty();
    }
    void saveToken() {
        std::string s = "{\n  \"access_token\": \"" + JsonEscape(accessToken) + "\",\n"
            "  \"refresh_token\": \"" + JsonEscape(refreshToken) + "\",\n"
            "  \"expires_at\": " + std::to_string((long long)expiresAt) + "\n}\n";
        WriteFileText(baseDir + L"\\token.json", s);
    }
    static std::string HostOf(const std::string& url) {
        size_t a = url.find("://");
        size_t b = url.find('/', a == std::string::npos ? 0 : a + 3);
        std::string host = url.substr(a == std::string::npos ? 0 : a + 3, b == std::string::npos ? std::string::npos : b - (a + 3));
        return host;
    }
    static std::string PathOf(const std::string& url) {
        size_t a = url.find("://");
        size_t b = url.find('/', a == std::string::npos ? 0 : a + 3);
        return b == std::string::npos ? "/" : url.substr(b);
    }
    bool postToken(const std::string& body) {
        HttpResult r = HttpRequest("POST", HostOf(tokenUri), PathOf(tokenUri), body,
                                   "application/x-www-form-urlencoded", "");
        if (r.status != 200) { log("Loi lay token (HTTP " + std::to_string(r.status) + "): " + r.body.substr(0, 300)); return false; }
        Json j = JsonParser(r.body).parse();
        if (const Json* v = j.find("access_token")) accessToken = v->asStr();
        if (const Json* v = j.find("refresh_token")) { std::string rt = v->asStr(); if (!rt.empty()) refreshToken = rt; }
        double exp = 3600;
        if (const Json* v = j.find("expires_in")) exp = v->num;
        expiresAt = std::time(nullptr) + (time_t)exp;
        if (accessToken.empty()) return false;
        saveToken();
        return true;
    }
    bool refreshAccess() {
        if (refreshToken.empty()) return false;
        std::string body = "client_id=" + UrlEncode(clientId)
            + "&client_secret=" + UrlEncode(clientSecret)
            + "&refresh_token=" + UrlEncode(refreshToken)
            + "&grant_type=refresh_token";
        return postToken(body);
    }
    // Nghe localhost 1 lan de nhan code OAuth, mo trinh duyet cho user dang nhap.
    bool interactiveLogin() {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { log("WSAStartup that bai"); return false; }
        SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;
        if (bind(listener, (sockaddr*)&addr, sizeof(addr)) != 0 || listen(listener, 1) != 0) {
            log("Khong mo duoc cong localhost de nhan code Google");
            closesocket(listener); WSACleanup(); return false;
        }
        sockaddr_in bound{};
        int blen = sizeof(bound);
        getsockname(listener, (sockaddr*)&bound, &blen);
        int port = ntohs(bound.sin_port);
        std::string redirect = "http://127.0.0.1:" + std::to_string(port);
        std::string url = authUri + "?client_id=" + UrlEncode(clientId)
            + "&redirect_uri=" + UrlEncode(redirect)
            + "&response_type=code&scope=" + UrlEncode("https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets")
            + "&access_type=offline&prompt=consent";
        log("Mo trinh duyet de dang nhap Google…");
        ShellExecuteW(nullptr, L"open", Utf8ToWide(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        fd_set set; FD_ZERO(&set); FD_SET(listener, &set);
        timeval tv{ 180, 0 };
        SOCKET client = INVALID_SOCKET;
        if (select(0, &set, nullptr, nullptr, &tv) > 0) client = accept(listener, nullptr, nullptr);
        closesocket(listener);
        if (client == INVALID_SOCKET) { log("Het thoi gian doi dang nhap (180s), thu lai"); WSACleanup(); return false; }
        std::string req;
        char buf[4096];
        int n = recv(client, buf, sizeof(buf) - 1, 0);
        if (n > 0) { buf[n] = 0; req = buf; }
        const char* okHtml = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<html><body><h2>Dang nhap xong, quay lai app FilmPosterApp.</h2></body></html>";
        send(client, okHtml, (int)strlen(okHtml), 0);
        closesocket(client);
        WSACleanup();
        std::string code;
        size_t q = req.find("code=");
        if (q != std::string::npos) {
            size_t e = req.find_first_of(" &", q + 5);
            code = UrlDecode(req.substr(q + 5, e == std::string::npos ? std::string::npos : e - (q + 5)));
        }
        if (code.empty()) { log("Khong nhan duoc code tu Google, thu lai"); return false; }
        std::string body = "code=" + UrlEncode(code)
            + "&client_id=" + UrlEncode(clientId)
            + "&client_secret=" + UrlEncode(clientSecret)
            + "&redirect_uri=" + UrlEncode(redirect)
            + "&grant_type=authorization_code";
        return postToken(body);
    }
    bool ensureToken() {
        if (!accessToken.empty() && expiresAt > std::time(nullptr) + 60) return true;
        if (refreshAccess()) return true;
        return interactiveLogin();
    }
    // Goi API Google, tu refresh token 1 lan khi gap 401.
    HttpResult api(const std::string& method, const std::string& host, const std::string& path,
                   const std::string& body, const std::string& contentType) {
        if (!ensureToken()) return HttpResult{ 0, "", "Chua dang nhap Google duoc" };
        HttpResult r = HttpRequest(method, host, path, body, contentType, accessToken);
        if (r.status == 401 && refreshAccess()) {
            r = HttpRequest(method, host, path, body, contentType, accessToken);
        }
        return r;
    }
    std::string firstSheetTitle(const std::string& sheetId) {
        HttpResult r = api("GET", "sheets.googleapis.com", "/v4/spreadsheets/" + sheetId, "", "");
        if (r.status != 200) return "";
        Json j = JsonParser(r.body).parse();
        const Json* sheets = j.find("sheets");
        if (!sheets || sheets->arr.empty()) return "";
        const Json* props = sheets->arr[0].find("properties");
        if (!props) return "";
        const Json* title = props->find("title");
        return title ? title->asStr() : "";
    }
    // Tra ve map id_thuong -> (row, poster, background)
    std::map<std::string, std::tuple<int, std::string, std::string>> sheetRows(
            const std::string& sheetId, const std::string& title) {
        std::map<std::string, std::tuple<int, std::string, std::string>> out;
        std::string range = UrlEncode(title + "!A:G");
        HttpResult r = api("GET", "sheets.googleapis.com",
                           "/v4/spreadsheets/" + sheetId + "/values/" + range, "", "");
        if (r.status != 200) { log("Khong doc duoc Sheet (HTTP " + std::to_string(r.status) + ")"); return out; }
        Json j = JsonParser(r.body).parse();
        const Json* values = j.find("values");
        if (!values) return out;
        for (size_t i = 0; i < values->arr.size(); i++) {
            const Json& row = values->arr[i];
            auto cell = [&](size_t c) -> std::string {
                return (row.type == Json::Arr && c < row.arr.size()) ? row.arr[c].asStr() : "";
            };
            std::string id = ToLowerStr(TrimStr(cell(0)));
            if (id.empty() || id == "id") continue;
            out[id] = { (int)i + 1, TrimStr(cell(4)), TrimStr(cell(6)) };
        }
        return out;
    }
    bool writeCell(const std::string& sheetId, const std::string& title,
                   const std::string& col, int row, const std::string& link) {
        std::string range = UrlEncode(title + "!" + col + std::to_string(row));
        std::string body = "{\"values\":[[\"" + JsonEscape(link) + "\"]]}";
        HttpResult r = api("PUT", "sheets.googleapis.com",
                           "/v4/spreadsheets/" + sheetId + "/values/" + range + "?valueInputOption=RAW",
                           body, "application/json");
        return r.status == 200;
    }
    // Up 1 anh len Drive, share public, tra ve file id ("" neu loi).
    std::string uploadImage(const std::wstring& filePath, const std::string& filmId,
                            const std::string& target, const std::string& folderId) {
        std::string data;
        if (!ReadFileBytes(filePath, data)) return "";
        std::wstring wpath(filePath);
        size_t dotPos = wpath.find_last_of(L'.');
        std::string ext = dotPos == std::wstring::npos ? ".jpg"
            : ToLowerStr(WideToUtf8(wpath.substr(dotPos)));
        std::string mime = ext == ".png" ? "image/png" : ext == ".webp" ? "image/webp" : "image/jpeg";
        std::string name = filmId;
        name.erase(std::remove(name.begin(), name.end(), ' '), name.end());
        name += "-" + target + ext;
        std::string boundary = "FilmPosterAppBoundary1234";
        std::string meta = "{\"name\":\"" + JsonEscape(name) + "\",\"mimeType\":\"" + mime + "\"";
        if (!folderId.empty()) meta += ",\"parents\":[\"" + JsonEscape(folderId) + "\"]";
        meta += "}";
        std::string body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
            + meta + "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n"
            + data + "\r\n--" + boundary + "--\r\n";
        HttpResult r = api("POST", "www.googleapis.com",
                           "/upload/drive/v3/files?uploadType=multipart",
                           body, "multipart/related; boundary=" + boundary);
        if (r.status != 200) { log("Up Drive loi (HTTP " + std::to_string(r.status) + "): " + r.body.substr(0, 200)); return ""; }
        Json j = JsonParser(r.body).parse();
        const Json* id = j.find("id");
        if (!id) return "";
        std::string fileId = id->asStr();
        HttpResult p = api("POST", "www.googleapis.com",
                           "/drive/v3/files/" + fileId + "/permissions",
                           "{\"type\":\"anyone\",\"role\":\"reader\"}", "application/json");
        if (p.status != 200) log("  ! Khong share public duoc " + filmId + " (" + target + ")");
        return fileId;
    }
};

// ---------- Ten file -> phim X ----------
static bool ParseFilmJob(const std::string& fileName, const std::string& defaultTarget,
                         std::string& filmId, std::string& target) {
    std::string stem = fileName;
    size_t dot = stem.find_last_of('.');
    if (dot != std::string::npos) stem = stem.substr(0, dot);
    std::string s = ToLowerStr(TrimStr(stem));
    if (s.rfind("phim", 0) != 0) return false;
    size_t i = 4;
    while (i < s.size() && (s[i] == ' ' || s[i] == '-' || s[i] == '_')) i++;
    size_t numStart = i;
    while (i < s.size() && isdigit((unsigned char)s[i])) i++;
    if (i == numStart) return false;
    int num = std::stoi(s.substr(numStart, i - numStart));
    while (i < s.size() && (s[i] == ' ' || s[i] == '-' || s[i] == '_')) i++;
    std::string suffix = s.substr(i);
    if (suffix.empty()) target = defaultTarget;
    else if (suffix == "bg" || suffix == "background") target = "background";
    else return false;
    filmId = "phim " + std::to_string(num);
    return true;
}
struct Job { std::wstring path; std::string fileName; std::string filmId; std::string target; };
static void CollectJobs(const std::wstring& postersDir, const std::wstring& backgroundsDir,
                        const std::string& only, std::vector<Job>& jobs, std::vector<std::string>& bad) {
    struct Dir { std::wstring dir; std::string defTarget; };
    for (auto d : { Dir{ postersDir, "poster" }, Dir{ backgroundsDir, "background" } }) {
        std::wstring pattern = d.dir + L"\\*.*";
        WIN32_FIND_DATAW fd{};
        HANDLE h = FindFirstFileW(pattern.c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;
        std::vector<std::wstring> names;
        do { if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) names.push_back(fd.cFileName); }
        while (FindNextFileW(h, &fd));
        FindClose(h);
        std::sort(names.begin(), names.end());
        for (auto& name : names) {
            std::string fn = WideToUtf8(name);
            std::string ext = ToLowerStr(fn.substr(fn.find_last_of('.') == std::string::npos ? fn.size() : fn.find_last_of('.')));
            if (ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp") continue;
            std::string filmId, target;
            if (ParseFilmJob(fn, d.defTarget, filmId, target)) {
                if ((only == "poster" || only == "background") && target != only) continue;
                jobs.push_back(Job{ d.dir + L"\\" + name, fn, filmId, target });
            } else {
                bad.push_back(WideToUtf8(d.dir + L"\\" + name));
            }
        }
    }
}

static std::wstring JoinDir(const std::wstring& base, const std::string& dirUtf8) {
    std::wstring d = Utf8ToWide(dirUtf8);
    if (d.size() >= 2 && d[1] == L':') return d;  // duong dan tuyet doi
    if (!d.empty() && (d[0] == L'\\' || d[0] == L'/')) return d;
    return base + L"\\" + d;
}

// ---------- Chay 1 luot up anh ----------
struct RunResult { int done = 0, skipped = 0, missing = 0, failed = 0; };
static bool RunUpload(const Config& cfg, bool force, bool dryRun, const std::string& only,
                      const std::function<void(const std::string&)>& log, RunResult& res) {
    if (cfg.spreadsheetId.empty()) { log("LỖI: Chưa có spreadsheet_id trong config.json"); return false; }
    std::wstring base = ExeDir();
    std::wstring postersDir = JoinDir(base, cfg.postersDir.empty() ? "posters" : cfg.postersDir);
    std::wstring bgDir = JoinDir(base, cfg.backgroundsDir.empty() ? "backgrounds" : cfg.backgroundsDir);
    std::vector<Job> jobs;
    std::vector<std::string> bad;
    CollectJobs(postersDir, bgDir, only, jobs, bad);
    for (auto& f : bad) {
        log("BO QUA (ten sai quy tac): " + f);
        log("  (poster: 'phim X.jpg' | background: 'phim X-bg.jpg' hoac bo vao thu muc backgrounds/)");
    }
    if (jobs.empty()) {
        log("LỖI: Khong co file anh nao dung quy tac. Bo 'phim X.jpg' vao posters/ hoac backgrounds/ roi chay lai.");
        return false;
    }
    GoogleApi api;
    api.baseDir = base;
    api.log = log;
    if (!api.loadCredentials()) { log("LỖI: Khong thay credentials.json ben canh file .exe"); return false; }
    api.loadToken();
    if (!api.ensureToken()) { log("LỖI: Dang nhap Google that bai"); return false; }
    std::string title = cfg.sheetName.empty() ? api.firstSheetTitle(cfg.spreadsheetId) : cfg.sheetName;
    if (title.empty()) { log("LỖI: Khong doc duoc ten sheet (kiem tra spreadsheet_id / quyen share)"); return false; }
    log("Sheet: " + title + " | poster: cot E | background: cot G");
    auto rows = api.sheetRows(cfg.spreadsheetId, title);
    log("Doc duoc " + std::to_string(rows.size()) + " phim trong Sheet.");
    for (auto& job : jobs) {
        std::string col = job.target == "poster" ? "E" : "G";
        std::string label = job.target == "poster" ? "poster" : "background";
        auto it = rows.find(ToLowerStr(job.filmId));
        if (it == rows.end()) { log("KHONG CO TRONG SHEET: " + job.filmId + " (" + job.fileName + ", " + label + ")"); res.missing++; continue; }
        int row = std::get<0>(it->second);
        std::string current = job.target == "poster" ? std::get<1>(it->second) : std::get<2>(it->second);
        if (!current.empty() && !force) {
            log("BO QUA (da co " + label + ", tick 'Ghi de anh cu' de ghi de): " + job.filmId + " (hang " + std::to_string(row) + ")");
            res.skipped++; continue;
        }
        if (dryRun) { log("[DRY-RUN] Se up " + job.fileName + " (" + label + ") -> hang " + std::to_string(row) + ", cot " + col); res.done++; continue; }
        std::string fileId = api.uploadImage(job.path, job.filmId, job.target, cfg.driveFolderId);
        if (fileId.empty()) { log("LOI " + job.filmId + " (" + job.fileName + ", " + label + "): up Drive that bai"); res.failed++; continue; }
        std::string link = "https://drive.google.com/uc?id=" + fileId;
        if (!api.writeCell(cfg.spreadsheetId, title, col, row, link)) {
            log("LOI " + job.filmId + " (" + job.fileName + ", " + label + "): ghi Sheet that bai"); res.failed++; continue;
        }
        log("OK " + job.filmId + " (" + label + ") -> hang " + std::to_string(row) + ", cot " + col + " : " + link);
        res.done++;
    }
    log("\nXong: up+ghi " + std::to_string(res.done) + " | bo qua (da co anh) " + std::to_string(res.skipped)
        + " | khong co trong Sheet " + std::to_string(res.missing) + " | loi " + std::to_string(res.failed));
    if (!dryRun && res.done > 0) log("Mo lai Stremio, doi vai phut (server cache 5 phut) la thay anh moi.");
    return true;
}

// ---------- Giao dien Win32 ----------
#define IDC_SHEET_EDIT      101
#define IDC_FOLDER_EDIT     102
#define IDC_POSTERS_EDIT    103
#define IDC_BG_EDIT         104
#define IDC_FORCE_CHK       105
#define IDC_BTN_POSTER      111
#define IDC_BTN_BG          112
#define IDC_BTN_BOTH        113
#define IDC_BTN_DRY         114
#define IDC_BTN_SAVE        115
#define IDC_BTN_BROWSE_P    116
#define IDC_BTN_BROWSE_B    117
#define IDC_BTN_OPEN_P      118
#define IDC_BTN_OPEN_B      119
#define IDC_LOG_EDIT        121
#define IDC_STATUS          122
#define IDC_CRED_LABEL      123
#define WM_APP_LOG          (WM_APP + 1)
#define WM_APP_DONE         (WM_APP + 2)

static HWND g_hwnd, g_editSheet, g_editFolder, g_editPosters, g_editBg, g_chkForce,
            g_btnPoster, g_btnBg, g_btnBoth, g_btnDry, g_logEdit, g_status, g_credLabel;
static HFONT g_font;
static bool g_running = false;
static Config g_cfg;
static std::wstring g_cfgPath;

static std::wstring GetEditText(HWND h) {
    int n = GetWindowTextLengthW(h);
    std::wstring s(n, 0);
    GetWindowTextW(h, &s[0], n + 1);
    return s;
}
static void SetEditText(HWND h, const std::wstring& s) { SetWindowTextW(h, s.c_str()); }
static void LogToUi(const std::string& msg) {
    if (!g_hwnd) return;
    std::string* p = new std::string(msg);
    PostMessageW(g_hwnd, WM_APP_LOG, 0, (LPARAM)p);
}
static void AppendLog(const std::string& msg) {
    if (!g_logEdit) return;
    std::wstring w = Utf8ToWide(msg) + L"\r\n";
    int len = GetWindowTextLengthW(g_logEdit);
    SendMessageW(g_logEdit, EM_SETSEL, (WPARAM)len, (LPARAM)len);
    SendMessageW(g_logEdit, EM_REPLACESEL, 0, (LPARAM)w.c_str());
}
static void RefreshCredLabel() {
    std::wstring base = ExeDir();
    DWORD a1 = GetFileAttributesW((base + L"\\token.json").c_str());
    DWORD a2 = GetFileAttributesW((base + L"\\credentials.json").c_str());
    std::wstring t;
    if (a1 != INVALID_FILE_ATTRIBUTES) t = L"✓ Đã đăng nhập Google (có token.json)";
    else if (a2 != INVALID_FILE_ATTRIBUTES) t = L"! Có credentials.json, chưa đăng nhập (bấm Push sẽ mở trình duyệt)";
    else t = L"✗ Chưa có credentials.json — xem HUONG-DAN-CPP.txt bước 1";
    SetWindowTextW(g_credLabel, t.c_str());
}
static void SaveConfigFromUi() {
    g_cfg.spreadsheetId = WideToUtf8(GetEditText(g_editSheet));
    g_cfg.driveFolderId = WideToUtf8(GetEditText(g_editFolder));
    g_cfg.postersDir = WideToUtf8(GetEditText(g_editPosters));
    g_cfg.backgroundsDir = WideToUtf8(GetEditText(g_editBg));
    if (g_cfg.postersDir.empty()) g_cfg.postersDir = "posters";
    if (g_cfg.backgroundsDir.empty()) g_cfg.backgroundsDir = "backgrounds";
    SaveConfig(g_cfgPath, g_cfg);
}
static std::wstring PickFolder(HWND owner, const std::wstring& current) {
    BROWSEINFOW bi{};
    bi.hwndOwner = owner;
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
    PIDLIST_ABSOLUTE pidl = SHBrowseForFolderW(&bi);
    if (!pidl) return L"";
    wchar_t path[MAX_PATH] = { 0 };
    SHGetPathFromIDListW(pidl, path);
    CoTaskMemFree(pidl);
    return path;
}
static void OpenDir(const std::wstring& dir) {
    std::wstring full = dir;
    if (full.size() < 2 || full[1] != L':') full = ExeDir() + L"\\" + dir;
    CreateDirectoryW(full.c_str(), nullptr);
    ShellExecuteW(nullptr, L"open", full.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}
struct WorkParams { std::string only; bool dryRun; bool force; Config cfg; };
static DWORD WINAPI WorkerThread(LPVOID param) {
    std::unique_ptr<WorkParams> wp((WorkParams*)param);
    RunResult res;
    bool ok = RunUpload(wp->cfg, wp->force, wp->dryRun, wp->only, LogToUi, res);
    std::string status = ok
        ? ("Xong: up+ghi " + std::to_string(res.done) + " | bỏ qua " + std::to_string(res.skipped)
           + " | không có trong Sheet " + std::to_string(res.missing) + " | lỗi " + std::to_string(res.failed))
        : "Lỗi — xem chi tiết trong bảng kết quả.";
    std::string* p = new std::string(status);
    PostMessageW(g_hwnd, WM_APP_DONE, 0, (LPARAM)p);
    return 0;
}
static void StartWork(const std::string& only, bool dryRun) {
    if (g_running) return;
    SaveConfigFromUi();
    g_running = true;
    for (HWND b : { g_btnPoster, g_btnBg, g_btnBoth, g_btnDry }) EnableWindow(b, FALSE);
    SetWindowTextW(g_status, L"Đang chạy… (lần đầu sẽ mở trình duyệt đăng nhập Google)");
    LogToUi("============================================================");
    LogToUi(std::string("Bắt đầu push ") + only + (dryRun ? " — XEM TRƯỚC, không ghi thật" : ""));
    WorkParams* wp = new WorkParams{ only, dryRun,
        SendMessageW(g_chkForce, BM_GETCHECK, 0, 0) == BST_CHECKED, g_cfg };
    HANDLE h = CreateThread(nullptr, 0, WorkerThread, wp, 0, nullptr);
    if (h) CloseHandle(h);
}
static void FinishWork(const std::string& status) {
    g_running = false;
    for (HWND b : { g_btnPoster, g_btnBg, g_btnBoth, g_btnDry }) EnableWindow(b, TRUE);
    SetWindowTextW(g_status, Utf8ToWide(status).c_str());
    RefreshCredLabel();
}
static HWND MakeLabel(HWND parent, const wchar_t* text, int x, int y, int w, int h) {
    HWND c = CreateWindowExW(0, L"STATIC", text, WS_CHILD | WS_VISIBLE, x, y, w, h, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    SendMessageW(c, WM_SETFONT, (WPARAM)g_font, TRUE);
    return c;
}
static HWND MakeButton(HWND parent, const wchar_t* text, int id, int x, int y, int w, int h) {
    HWND c = CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, x, y, w, h, parent, (HMENU)(INT_PTR)id, GetModuleHandleW(nullptr), nullptr);
    SendMessageW(c, WM_SETFONT, (WPARAM)g_font, TRUE);
    return c;
}
static HWND MakeEdit(HWND parent, int id, int x, int y, int w) {
    HWND c = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
                             x, y, w, 24, parent, (HMENU)(INT_PTR)id, GetModuleHandleW(nullptr), nullptr);
    SendMessageW(c, WM_SETFONT, (WPARAM)g_font, TRUE);
    return c;
}
static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_CREATE: {
        g_font = CreateFontW(16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY,
                             DEFAULT_PITCH | FF_DONTCARE, L"MS Shell Dlg");
        HINSTANCE hInst = GetModuleHandleW(nullptr);
        MakeLabel(hwnd, L"Cấu hình", 12, 10, 200, 20);
        MakeLabel(hwnd, L"Spreadsheet ID:", 12, 36, 110, 20);
        g_editSheet = MakeEdit(hwnd, IDC_SHEET_EDIT, 128, 34, 560);
        MakeLabel(hwnd, L"Drive folder ID (trống = root):", 12, 66, 170, 20);
        g_editFolder = MakeEdit(hwnd, IDC_FOLDER_EDIT, 188, 64, 500);
        MakeLabel(hwnd, L"Thư mục poster:", 12, 96, 110, 20);
        g_editPosters = MakeEdit(hwnd, IDC_POSTERS_EDIT, 128, 94, 380);
        MakeButton(hwnd, L"Chọn…", IDC_BTN_BROWSE_P, 516, 94, 70, 24);
        MakeButton(hwnd, L"Mở thư mục", IDC_BTN_OPEN_P, 594, 94, 94, 24);
        MakeLabel(hwnd, L"Thư mục background:", 12, 126, 140, 20);
        g_editBg = MakeEdit(hwnd, IDC_BG_EDIT, 158, 124, 350);
        MakeButton(hwnd, L"Chọn…", IDC_BTN_BROWSE_B, 516, 124, 70, 24);
        MakeButton(hwnd, L"Mở thư mục", IDC_BTN_OPEN_B, 594, 124, 94, 24);
        MakeButton(hwnd, L"Lưu cấu hình", IDC_BTN_SAVE, 128, 156, 110, 26);
        g_credLabel = MakeLabel(hwnd, L"", 250, 160, 440, 20);
        g_chkForce = CreateWindowExW(0, L"BUTTON", L"Ghi đè ảnh cũ (ô đã có link thì ghi đè, không tick thì bỏ qua)",
                                     WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 12, 190, 560, 22,
                                     hwnd, (HMENU)(INT_PTR)IDC_FORCE_CHK, hInst, nullptr);
        SendMessageW(g_chkForce, WM_SETFONT, (WPARAM)g_font, TRUE);
        g_btnPoster = MakeButton(hwnd, L"⬆ Push Poster", IDC_BTN_POSTER, 12, 220, 160, 38);
        g_btnBg = MakeButton(hwnd, L"⬆ Push Background", IDC_BTN_BG, 184, 220, 170, 38);
        g_btnBoth = MakeButton(hwnd, L"⬆ Push Cả Hai", IDC_BTN_BOTH, 366, 220, 150, 38);
        g_btnDry = MakeButton(hwnd, L"👀 Xem trước", IDC_BTN_DRY, 528, 220, 160, 38);
        MakeLabel(hwnd, L"Kết quả:", 12, 270, 200, 20);
        g_logEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_TABSTOP
                                    | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL, 12, 292, 676, 210,
                                    hwnd, (HMENU)(INT_PTR)IDC_LOG_EDIT, hInst, nullptr);
        SendMessageW(g_logEdit, WM_SETFONT, (WPARAM)g_font, TRUE);
        g_status = MakeLabel(hwnd, L"Sẵn sàng. Bỏ ảnh vào thư mục rồi bấm nút Push.", 12, 512, 676, 20);
        std::wstring base = ExeDir();
        g_cfgPath = base + L"\\config.json";
        g_cfg = LoadConfig(g_cfgPath);
        SetEditText(g_editSheet, Utf8ToWide(g_cfg.spreadsheetId));
        SetEditText(g_editFolder, Utf8ToWide(g_cfg.driveFolderId));
        SetEditText(g_editPosters, Utf8ToWide(g_cfg.postersDir.empty() ? "posters" : g_cfg.postersDir));
        SetEditText(g_editBg, Utf8ToWide(g_cfg.backgroundsDir.empty() ? "backgrounds" : g_cfg.backgroundsDir));
        RefreshCredLabel();
        return 0;
    }
    case WM_COMMAND: {
        int id = LOWORD(wParam);
        if (id == IDC_BTN_POSTER) StartWork("poster", false);
        else if (id == IDC_BTN_BG) StartWork("background", false);
        else if (id == IDC_BTN_BOTH) StartWork("both", false);
        else if (id == IDC_BTN_DRY) StartWork("both", true);
        else if (id == IDC_BTN_SAVE) { SaveConfigFromUi(); AppendLog("Đã lưu config.json."); RefreshCredLabel(); }
        else if (id == IDC_BTN_BROWSE_P) { std::wstring d = PickFolder(hwnd, GetEditText(g_editPosters)); if (!d.empty()) SetEditText(g_editPosters, d); }
        else if (id == IDC_BTN_BROWSE_B) { std::wstring d = PickFolder(hwnd, GetEditText(g_editBg)); if (!d.empty()) SetEditText(g_editBg, d); }
        else if (id == IDC_BTN_OPEN_P) OpenDir(GetEditText(g_editPosters));
        else if (id == IDC_BTN_OPEN_B) OpenDir(GetEditText(g_editBg));
        return 0;
    }
    case WM_APP_LOG: {
        std::string* p = (std::string*)lParam;
        if (p) { AppendLog(*p); delete p; }
        return 0;
    }
    case WM_APP_DONE: {
        std::string* p = (std::string*)lParam;
        if (p) { FinishWork(*p); delete p; }
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int nCmdShow) {
    WNDCLASSW wc{};
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszClassName = L"FilmPosterAppCpp";
    if (!RegisterClassW(&wc)) return 1;
    g_hwnd = CreateWindowExW(0, L"FilmPosterAppCpp",
                             L"FilmPosterApp C++ v1.0 — MyFilms Poster + Background",
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                             CW_USEDEFAULT, CW_USEDEFAULT, 716, 580,
                             nullptr, nullptr, hInstance, nullptr);
    if (!g_hwnd) return 1;
    ShowWindow(g_hwnd, nCmdShow);
    UpdateWindow(g_hwnd);
    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return (int)msg.wParam;
}
