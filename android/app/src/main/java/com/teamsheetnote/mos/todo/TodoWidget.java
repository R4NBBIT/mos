package com.teamsheetnote.mos.todo;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.format.TextStyle;
import java.util.Locale;

/** 홈 화면 위젯: 오늘 할 일(최대 8줄). 줄을 누르면 완료 켜고 끄기, ↻는 새로 고침, 날짜는 ㅁㅇㅅ 열기 */
public class TodoWidget extends AppWidgetProvider {
    static final String TOGGLE = "com.teamsheetnote.mos.todo.TOGGLE";
    static final String REFRESH = "com.teamsheetnote.mos.todo.REFRESH";
    private static final int[] ROWS = {
            R.id.row0, R.id.row1, R.id.row2, R.id.row3, R.id.row4, R.id.row5, R.id.row6, R.id.row7,
    };

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
            show(context, data.getJSONArray("todos"), null);
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

    private static void show(Context context, JSONArray todos, String message) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget);
        LocalDate now = LocalDate.now();
        String weekday = now.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.KOREAN);
        views.setTextViewText(R.id.title, now.getMonthValue() + "월 " + now.getDayOfMonth() + "일 (" + weekday + ")");
        views.setOnClickPendingIntent(R.id.refresh, broadcast(context, 1, new Intent(REFRESH)));
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(Api.ORIGIN + "/#/todo"));
        views.setOnClickPendingIntent(R.id.title,
                PendingIntent.getActivity(context, 2, open, PendingIntent.FLAG_IMMUTABLE));
        if (message != null) {
            views.setViewVisibility(R.id.message, View.VISIBLE);
            views.setTextViewText(R.id.message, message);
            views.setTextViewText(R.id.count, "");
        } else {
            views.setViewVisibility(R.id.message, View.GONE);
        }
        int total = todos == null ? 0 : todos.length();
        int done = 0;
        for (int index = 0; index < ROWS.length; index++) {
            if (todos == null || index >= total) {
                views.setViewVisibility(ROWS[index], View.GONE);
                continue;
            }
            JSONObject item = todos.optJSONObject(index);
            boolean isDone = item.optBoolean("done", false);
            String time = item.isNull("time") ? "" : item.optString("time", "") + "  ";
            String text = (isDone ? "☑  " : "☐  ") + time + item.optString("title", "");
            if (index == ROWS.length - 1 && total > ROWS.length) {
                text = "외 " + (total - ROWS.length + 1) + "개 더(날짜를 눌러 ㅁㅇㅅ에서 보기)";
            }
            views.setViewVisibility(ROWS[index], View.VISIBLE);
            views.setTextViewText(ROWS[index], text);
            Intent toggle = new Intent(TOGGLE)
                    .putExtra("id", item.optString("id"))
                    .putExtra("done", isDone);
            views.setOnClickPendingIntent(ROWS[index], broadcast(context, 100 + index, toggle));
        }
        if (todos != null) {
            for (int index = 0; index < total; index++) {
                if (todos.optJSONObject(index).optBoolean("done", false)) {
                    done++;
                }
            }
            views.setTextViewText(R.id.count, done + "/" + total);
            if (total == 0) {
                views.setViewVisibility(R.id.message, View.VISIBLE);
                views.setTextViewText(R.id.message, "오늘 할 일이 없어요.");
            }
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, TodoWidget.class));
        manager.updateAppWidget(ids, views);
    }
}
