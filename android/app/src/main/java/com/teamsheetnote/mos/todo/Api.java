package com.teamsheetnote.mos.todo;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ㅁㅇㅅ 서버와 이야기하기. TODO는 AI 연결과 같은 MCP 주소(/mcp)의 도구를 그대로 쓴다
 * (list_todos, complete_todo). 토큰은 TODO 전용(OAuth, PKCE).
 */
final class Api {
    static final String ORIGIN = "https://docs.teamsheet-note.com";
    static final String REDIRECT = "com.teamsheetnote.mos.todo:/oauth";

    static final class AuthLost extends Exception {
        AuthLost() {
            super("다시 로그인해야 해요");
        }
    }

    private Api() {
    }

    static String post(String path, String contentType, String body, String bearer, int[] status) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + path).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", contentType);
        connection.setRequestProperty("Accept", "application/json");
        if (bearer != null) {
            connection.setRequestProperty("Authorization", "Bearer " + bearer);
        }
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int code = connection.getResponseCode();
        status[0] = code;
        InputStream in = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (in == null) {
            return "";
        }
        try (InputStream stream = in) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) > 0) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toString("UTF-8");
        }
    }

    /** Map.of는 안드로이드 11부터라 직접(순서 유지) */
    static Map<String, String> pairs(String... keyValues) {
        Map<String, String> map = new LinkedHashMap<>();
        for (int index = 0; index + 1 < keyValues.length; index += 2) {
            map.put(keyValues[index], keyValues[index + 1]);
        }
        return map;
    }

    static String form(Map<String, String> values) throws Exception {
        StringBuilder text = new StringBuilder();
        for (Map.Entry<String, String> entry : values.entrySet()) {
            if (text.length() > 0) {
                text.append('&');
            }
            text.append(URLEncoder.encode(entry.getKey(), "UTF-8"))
                    .append('=')
                    .append(URLEncoder.encode(entry.getValue(), "UTF-8"));
        }
        return text.toString();
    }

    /** 새로 고침 토큰으로 새 토큰(쓸 때마다 새 새로 고침 토큰을 준다) */
    static synchronized void refresh(Context context) throws Exception {
        SharedPreferences prefs = Store.prefs(context);
        String refresh = prefs.getString("refresh_token", null);
        String clientId = prefs.getString("client_id", null);
        if (refresh == null || clientId == null) {
            throw new AuthLost();
        }
        int[] status = new int[1];
        String body = post("/oauth/token", "application/x-www-form-urlencoded",
                form(pairs("grant_type", "refresh_token", "refresh_token", refresh, "client_id", clientId)),
                null, status);
        if (status[0] != 200) {
            Store.signOut(context);
            throw new AuthLost();
        }
        saveTokens(context, new JSONObject(body));
    }

    static void saveTokens(Context context, JSONObject tokens) throws Exception {
        Store.prefs(context).edit()
                .putString("access_token", tokens.getString("access_token"))
                .putString("refresh_token", tokens.getString("refresh_token"))
                .apply();
    }

    /** MCP 도구 부르기. 접근 토큰이 끝났으면 한 번 새로 받고 다시 */
    static JSONObject tool(Context context, String name, JSONObject arguments) throws Exception {
        for (int attempt = 0; attempt < 2; attempt++) {
            String access = Store.prefs(context).getString("access_token", null);
            if (access == null) {
                refresh(context);
                access = Store.prefs(context).getString("access_token", null);
            }
            JSONObject message = new JSONObject()
                    .put("jsonrpc", "2.0")
                    .put("id", 1)
                    .put("method", "tools/call")
                    .put("params", new JSONObject().put("name", name).put("arguments", arguments));
            int[] status = new int[1];
            String body = post("/mcp", "application/json", message.toString(), access, status);
            if (status[0] == 401) {
                refresh(context);
                continue;
            }
            if (status[0] != 200) {
                throw new Exception("서버 오류 " + status[0]);
            }
            JSONObject result = new JSONObject(body).getJSONObject("result");
            if (result.optBoolean("isError", false)) {
                JSONArray content = result.optJSONArray("content");
                String text = content != null && content.length() > 0
                        ? content.getJSONObject(0).optString("text", "") : "";
                throw new Exception(text);
            }
            return result.optJSONObject("structuredContent");
        }
        throw new AuthLost();
    }
}
