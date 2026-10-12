/*
 * Catan RL bridge bot for JSettlers (docs/BENCHMARK.md Phase B).
 * Copyright (C) 2026 the settlers_of_catan_rl authors. GPL-3, see BridgeClient.java.
 */
package catanrl;

import soc.server.SOCServer;

/**
 * Starts SOCServer with every built-in robot pinned to one parameter set: {@code -Dbridge.mix=smart}
 * (SOCServer.ROBOT_PARAMS_SMARTER, the "robot N" bots), {@code fast} (ROBOT_PARAMS_DEFAULT, the "droid N"
 * bots) or {@code default} (the server's own 30% fast / 70% smart split). The bots keep their names; only
 * the parameters they are handed at connect time change.
 */
public class Launch
{
    public static void main(String[] args)
    {
        String mix = System.getProperty("bridge.mix", "default");
        if (mix.equals("smart"))
            SOCServer.ROBOT_PARAMS_DEFAULT = SOCServer.ROBOT_PARAMS_SMARTER;
        else if (mix.equals("fast"))
            SOCServer.ROBOT_PARAMS_SMARTER = SOCServer.ROBOT_PARAMS_DEFAULT;
        else if (! mix.equals("default"))
            throw new IllegalArgumentException("bridge.mix must be smart, fast or default: " + mix);
        // A game nobody can win (every seat hemmed in, dev deck empty) runs until expiry: 120 min by default, which
        // stalls a bots-only series for two hours. -Dbridge.expire=<min> shortens it; an expired game writes no result.
        soc.server.SOCGameListAtServer.GAME_TIME_EXPIRE_MINUTES = Integer.getInteger("bridge.expire", 120);
        SOCServer.main(args);
    }
}
