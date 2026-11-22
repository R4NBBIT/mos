package com.teamsheetnote.mos.todo;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/** 로그인(ㅁㅇㅅ 사이트에서 승인)과 위젯 안내. 토큰은 TODO 전용이라 ㅁㅇㅅ 메시지는 못 본다 */
public class MainActivity extends Activity {
    private TextView status;
    private Button action;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText("ㅁㅇㅅ TODO 위젯");
        title.setTextSize(20);
        status = new TextView(this);
        status.setTextSize(15);
        status.setPadding(0, pad / 2, 0, pad / 2);
        action = new Button(this);
        layout.addView(title);
        layout.addView(status);
        layout.addView(action);
        layout.addView(lookPicker(pad));
        setContentView(layout);
        handle(getIntent());
        render();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    private void render() {
        if (Store.signedIn(this)) {
            status.setText("로그인했어요. 홈 화면을 길게 눌러 위젯 › TODO를 추가하세요.");
            action.setText("로그아웃");
            action.setOnClickListener(view -> {
                Store.signOut(this);
                TodoWidget.refreshAll(this);
                render();
            });
        } else {
            status.setText("ㅁㅇㅅ에 로그인하면 오늘 TODO가 위젯에 보여요.");
            action.setText("ㅁㅇㅅ로 로그인");
            action.setOnClickListener(view -> startLogin());
        }
    }

    /** 위젯 모양 고르기(ㅁㅇㅅ 테마와 같은 6가지 + 휴대폰 다크 모드 따라) */
    private LinearLayout lookPicker(int pad) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, pad, 0, 0);
        TextView label = new TextView(this);
        label.setText("위젯 모양");
        label.setTextSize(16);
        box.addView(label);
        RadioGroup group = new RadioGroup(this);
        String chosen = Look.chosen(this);
        for (int index = 0; index < Look.KEYS.length; index++) {
            RadioButton option = new RadioButton(this);
            option.setId(index + 1);
            option.setText(Look.NAMES[index]);
            option.setTextSize(15);
            group.addView(option);
            if (Look.KEYS[index].equals(chosen)) {
                option.setChecked(true);
            }
        }
        group.setOnCheckedChangeListener((radioGroup, checkedId) -> {
            int index = checkedId - 1;
            if (index >= 0 && index < Look.KEYS.length) {
                Look.choose(this, Look.KEYS[index]);
                TodoWidget.refreshAll(this);
            }
        });
        box.addView(group);
        return box;
    }

    private static String random(int bytes) {
        byte[] value = new byte[bytes];
        new SecureRandom().nextBytes(value);
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private void startLogin() {
        status.setText("준비하는 중…");
        new Thread(() -> {
            try {
                SharedPreferences prefs = Store.prefs(this);
                String clientId = prefs.getString("client_id", null);
                if (clientId == null) {
                    JSONObject body = new JSONObject()
                            .put("client_name", "ㅁㅇㅅ 위젯(안드로이드)")
                            .put("redirect_uris", new JSONArray().put(Api.REDIRECT));
                    int[] code = new int[1];
                    String reply = Api.post("/oauth/register", "application/json", body.toString(), null, code);
                    if (code[0] != 201) {
                        throw new Exception("등록 실패 " + code[0]);
                    }
                    clientId = new JSONObject(reply).getString("client_id");
                    prefs.edit().putString("client_id", clientId).apply();
                }
                String verifier = random(48);
                String stateValue = random(16);
                byte[] digest = MessageDigest.getInstance("SHA-256")
                        .digest(verifier.getBytes(StandardCharsets.US_ASCII));
                String challenge = Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                prefs.edit().putString("verifier", verifier).putString("state", stateValue).apply();
                Uri uri = Uri.parse(Api.ORIGIN + "/oauth/authorize").buildUpon()
                        .appendQueryParameter("response_type", "code")
                        .appendQueryParameter("client_id", clientId)
                        .appendQueryParameter("redirect_uri", Api.REDIRECT)
                        .appendQueryParameter("code_challenge", challenge)
                        .appendQueryParameter("code_challenge_method", "S256")
                        .appendQueryParameter("scope", "todo")
                        .appendQueryParameter("state", stateValue)
                        .build();
                runOnUiThread(() -> openInBrowser(uri));
            } catch (Exception error) {
                runOnUiThread(() -> status.setText("시작하지 못했어요. 인터넷 연결을 확인해 주세요."));
            }
        }).start();
    }

    /**
     * 승인 화면은 브라우저(가능하면 앱 안 탭)로 연다. 그냥 열면 휴대폰에 설치된 ㅁㅇㅅ 웹앱이 주소를 가로채
     * 승인 화면 없이 웹앱만 열리는 일이 있어서(2026-11-23 사용자 확인), 기본 브라우저를 골라 그쪽으로 보낸다.
     */
    private void openInBrowser(Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        Bundle extras = new Bundle();
        extras.putBinder("android.support.customtabs.extra.SESSION", null); // 앱 안 탭(Custom Tab)으로
        intent.putExtras(extras);
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"));
        ResolveInfo browser = getPackageManager().resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY);
        String target = browser == null || browser.activityInfo == null ? null : browser.activityInfo.packageName;
        if (target != null && !"android".equals(target)) {
            intent.setPackage(target);
        }
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            intent.setPackage(null);
            startActivity(intent);
        }
    }

    /** 사이트에서 '연결'을 누르면 com.teamsheetnote.mos.todo:/oauth?code=…&state=… 로 돌아온다 */
    private void handle(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"com.teamsheetnote.mos.todo".equals(data.getScheme())) {
            return;
        }
        SharedPreferences prefs = Store.prefs(this);
        String code = data.getQueryParameter("code");
        String stateValue = data.getQueryParameter("state");
        String verifier = prefs.getString("verifier", null);
        if (code == null || verifier == null || stateValue == null
                || !stateValue.equals(prefs.getString("state", null))) {
            status.setText(data.getQueryParameter("error") != null ? "연결을 거절했어요." : "로그인하지 못했어요. 다시 해 주세요.");
            return;
        }
        prefs.edit().remove("verifier").remove("state").apply();
        status.setText("로그인하는 중…");
        new Thread(() -> {
            try {
                int[] status = new int[1];
                String reply = Api.post("/oauth/token", "application/x-www-form-urlencoded",
                        Api.form(Api.pairs(
                                "grant_type", "authorization_code",
                                "code", code,
                                "code_verifier", verifier,
                                "client_id", prefs.getString("client_id", ""),
                                "redirect_uri", Api.REDIRECT)),
                        null, status);
                if (status[0] != 200) {
                    throw new Exception("토큰 실패 " + status[0]);
                }
                Api.saveTokens(this, new JSONObject(reply));
                TodoWidget.refreshAll(this);
                runOnUiThread(this::render);
            } catch (Exception error) {
                runOnUiThread(() -> this.status.setText("로그인하지 못했어요. 다시 해 주세요."));
            }
        }).start();
    }
}
