package com.teamsheetnote.mos.todo;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 위젯에 보일 카테고리(이 휴대폰에서만, 2026-11-23 사용자 요청 '회사에서는 회사 카테고리만').
 * 카테고리 이름으로 기억한다. 비어 있으면 모두 보인다.
 */
final class WidgetFilter {
    private static final String NAME = "mos_todo_widget_filter";
    private static final int MAX = 100;

    private WidgetFilter() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    static Set<String> chosen(Context context) {
        Set<String> out = new LinkedHashSet<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString("names", "[]"));
            for (int index = 0; index < array.length() && out.size() < MAX; index++) {
                String name = array.optString(index, "");
                if (!name.isEmpty()) {
                    out.add(name);
                }
            }
        } catch (Exception ignored) {
            // 깨졌으면 모두 보이기
        }
        return out;
    }

    static void save(Context context, Set<String> names) {
        JSONArray array = new JSONArray();
        for (String name : names) {
            if (array.length() >= MAX) {
                break;
            }
            array.put(name);
        }
        prefs(context).edit().putString("names", array.toString()).apply();
    }
}
