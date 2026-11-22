package com.teamsheetnote.mos.todo;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 홈 화면 위젯: 오늘 TODO(스크롤되는 목록). 줄을 누르면 완료 켜고 끄기, ↻는 새로 고침, 날짜는 ㅁㅇㅅ 열기.
 * 모양은 앱에서 고른 테마(Look: 기본, 다크, 스프레드시트, 메모장, 노션, Word)
 */
public class TodoWidget extends AppWidgetProvider {
    static final String TOGGLE = "com.teamsheetnote.mos.todo.TOGGLE";
    static final String REFRESH = "com.teamsheetnote.mos.todo.REFRESH";
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        refreshAsync(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (REFRESH.equals(action)) {
            refreshAsync(context);
        } else if (TOGGLE.equals(action)) {
            String id = intent.getStringExtra("id");
            boolean done = intent.getBooleanExtra("done", false);
            PendingResult pending = goAsync();
            new Thread(() -> {
                try {
                    Api.tool(context, "complete_todo", new JSONObject().put("id", id).put("done", !done));
                    draw(context);
                } catch (Exception error) {
                    show(context, null, error instanceof Api.AuthLost ? "앱을 열어 다시 로그인해 주세요." : "바꾸지 못했어요.");
                } finally {
                    pending.finish();
                }
            }).start();
        }
    }

    static void refreshAsync(Context context) {
        new Thread(() -> draw(context)).start();
    }

    static void refreshAll(Context context) {
        refreshAsync(context);
    }

    private static void draw(Context context) {
        if (!Store.signedIn(context)) {
            show(context, null, "앱을 열어 로그인해 주세요.");
            return;
        }
        try {
            String today = LocalDate.now().toString();
            JSONObject data = Api.tool(context, "list_todos", new JSONObject().put("start_day", today));
            JSONArray todos = data.getJSONArray("todos");
            // 이 휴대폰에서 고른 카테고리만(고르지 않았으면 모두)
            java.util.Set<String> chosen = WidgetFilter.chosen(context);
            if (!chosen.isEmpty()) {
                JSONArray kept = new JSONArray();
                for (int index = 0; index < todos.length(); index++) {
                    JSONObject item = todos.optJSONObject(index);
                    if (item != null && chosen.contains(item.optString("category", ""))) {
                        kept.put(item);
                    }
                }
                todos = kept;
            }
            show(context, todos, null);
        } catch (Api.AuthLost lost) {
            show(context, null, "앱을 열어 다시 로그인해 주세요.");
        } catch (Exception error) {
            show(context, null, "불러오지 못했어요. ↻를 눌러 다시.");
        }
    }

    private static PendingIntent broadcast(Context context, int code, Intent intent) {
        intent.setClass(context, TodoWidget.class);
        return PendingIntent.getBroadcast(context, code, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static int parseColor(String value, int fallback) {
        if (value == null || !value.matches("#[0-9a-fA-F]{6}")) {
            return fallback;
        }
        return 0xFF000000 | Integer.parseInt(value.substring(1), 16);
    }

    private static String dateText(Look look, LocalDate now) {
        String weekday = now.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.KOREAN);
        String base = now.getMonthValue() + "월 " + now.getDayOfMonth() + "일";
        switch (look.dateStyle) {
            case "sheet":
                return base + " TODO";
            case "memo":
                return "== " + base + " (" + weekday + ") ==";
            default:
                return base + " " + now.getDayOfWeek().getDisplayName(TextStyle.FULL, Locale.KOREAN);
        }
    }

    private static void show(Context context, JSONArray todos, String message) {
        Look look = Look.current(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), look.layout);
        LocalDate now = LocalDate.now();
        views.setTextViewText(R.id.title, dateText(look, now));
        views.setOnClickPendingIntent(R.id.refresh, broadcast(context, 1, new Intent(REFRESH)));
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(Api.ORIGIN + "/#/todo"));
        views.setOnClickPendingIntent(R.id.head,
                PendingIntent.getActivity(context, 2, open, PendingIntent.FLAG_IMMUTABLE));
        if (message != null) {
            views.setViewVisibility(R.id.message, View.VISIBLE);
            views.setTextViewText(R.id.message, message);
            // '앱을 열어 로그인해 주세요'를 누르면 위젯 앱(로그인 화면)이 열린다
            Intent app = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            views.setOnClickPendingIntent(R.id.message,
                    PendingIntent.getActivity(context, 4, app, PendingIntent.FLAG_IMMUTABLE));
            views.setTextViewText(R.id.count, "");
        } else {
            views.setViewVisibility(R.id.message, View.GONE);
        }
        // 순서는 TODO 화면 그대로(서버가 카테고리 순서, 사용자가 정한 순서로 준다. 2026-11-23 사용자 요청)
        List<JSONObject> items = new ArrayList<>();
        if (todos != null) {
            for (int index = 0; index < todos.length(); index++) {
                JSONObject item = todos.optJSONObject(index);
                if (item != null) {
                    items.add(item);
                }
            }
        }
        int total = items.size();
        int done = 0;
        for (JSONObject item : items) {
            if (item.optBoolean("done", false)) {
                done++;
            }
        }
        // 줄은 스크롤되는 목록(TodoWidgetService)이 그린다(2026-11-23 사용자 요청: 위젯 스크롤)
        if (todos != null) {
            JSONArray sorted = new JSONArray();
            for (JSONObject item : items) {
                sorted.put(item);
            }
            saveItems(context, sorted.toString());
        } else if (message != null && message.contains("로그인")) {
            saveItems(context, "[]");
        }
        Intent service = new Intent(context, TodoWidgetService.class);
        service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.list, service);
        Intent template = new Intent(TOGGLE).setClass(context, TodoWidget.class);
        int mutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        views.setPendingIntentTemplate(R.id.list,
                PendingIntent.getBroadcast(context, 5, template, PendingIntent.FLAG_UPDATE_CURRENT | mutable));
        if (todos != null) {
            String count = done + "/" + total;
            if ("memo".equals(look.key)) {
                count = "(" + count + ")";
            } else if ("word".equals(look.key)) {
                count = count + " 완료";
            }
            views.setTextViewText(R.id.count, count);
            if (look.key.equals("moon") || look.key.equals("night")) {
                views.setProgressBar(R.id.progress, 100, total == 0 ? 0 : done * 100 / total, false);
            }
            if (total == 0) {
                views.setViewVisibility(R.id.message, View.VISIBLE);
                views.setTextViewText(R.id.message, "오늘 TODO가 없어요.");
            }
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, TodoWidget.class));
        manager.updateAppWidget(widgetIds, views);
        manager.notifyAppWidgetViewDataChanged(widgetIds, R.id.list);
    }

    private static final String CACHE = "mos_todo_widget_items";

    private static void saveItems(Context context, String json) {
        context.getSharedPreferences(CACHE, Context.MODE_PRIVATE).edit().putString("items", json).apply();
    }

    /** 위젯 목록이 읽는 오늘 TODO(정렬된 채로) */
    static List<JSONObject> savedItems(Context context) {
        List<JSONObject> out = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(
                    context.getSharedPreferences(CACHE, Context.MODE_PRIVATE).getString("items", "[]"));
            for (int index = 0; index < array.length(); index++) {
                JSONObject item = array.optJSONObject(index);
                if (item != null) {
                    out.add(item);
                }
            }
        } catch (Exception ignored) {
            // 저장값이 깨졌으면 빈 목록
        }
        return out;
    }

    static int parseColorFor(String value, int fallback) {
        return parseColor(value, fallback);
    }
}
