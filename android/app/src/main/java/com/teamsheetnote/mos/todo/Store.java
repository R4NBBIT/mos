package com.teamsheetnote.mos.todo;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

/** 토큰, 클라이언트 ID를 운영체제 열쇠 저장소(Android Keystore)로 암호화해 보관 */
final class Store {
    private static final String NAME = "mos_todo_secure";

    private Store() {
    }

    static SharedPreferences prefs(Context context) {
        try {
            // security-crypto 1.0.0의 방식(MasterKey 빌더는 1.1.0 알파부터라 1.0.0에는 없음)
            String keyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
            return EncryptedSharedPreferences.create(
                    NAME,
                    keyAlias,
                    context,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Exception error) {
            throw new IllegalStateException("암호화 저장소를 열 수 없어요", error);
        }
    }

    static boolean signedIn(Context context) {
        return prefs(context).getString("refresh_token", null) != null;
    }

    static void signOut(Context context) {
        prefs(context).edit().remove("access_token").remove("refresh_token").apply();
    }
}
