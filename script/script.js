/**
 * Idea: make each gradient appear one at a time 
 * or maybe make top then bottom ones appear etc.
 */
;(function() {
    window.onload = function() {
        setTimeout(function() {
            document.querySelector('.background').className += ' show'
        }, 500)
        setTimeout(function() {
            document.querySelector('.title').className += ' show'
        }, 1000)
        setTimeout(function() {
            document.querySelector('.about').className += ' show'
        }, 1000)
    }
})(this)